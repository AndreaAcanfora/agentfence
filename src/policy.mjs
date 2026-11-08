import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse, ParseError } from './shell.mjs';
import { matchToken, matchPath, expandWord, resolvePath, expandBraces, globToRegExp, hasGlob, normalizePath } from './glob.mjs';

const PRESET_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'presets');
export const DEFAULT_EXTENDS = ['recommended'];
const RANK = { none: 0, allow: 1, ask: 2, deny: 3 };
const RULE_KEYS = new Set(['id', 'decision', 'reason', 'bash', 'bashRegex', 'read', 'write', 'tool', 'pipe', 'unless', 'when']);
const MATCH_KEYS = ['bash', 'bashRegex', 'read', 'write', 'tool', 'pipe'];

// Commands whose file arguments are read / written. Used to apply read/write
// path rules to Bash commands (`cat .env`, `cp key.pem /tmp`, `tee ~/.bashrc`).
const READERS = new Set(['cat', 'tac', 'less', 'more', 'head', 'tail', 'bat', 'batcat', 'nl', 'od', 'xxd', 'hexdump', 'strings',
  'base64', 'base32', 'cp', 'scp', 'rsync', 'tar', 'zip', 'gzip', 'bzip2', 'xz', 'zstd', '7z', 'curl', 'wget', 'grep', 'egrep', 'fgrep',
  'rg', 'ag', 'awk', 'gawk', 'sed', 'sort', 'uniq', 'cut', 'diff', 'cmp', 'source', '.', 'jq', 'yq', 'openssl', 'gpg', 'nc', 'ncat',
  'socat', 'mail', 'sendmail', 'view', 'vim', 'vi', 'nano', 'emacs', 'code', 'open', 'xdg-open', 'pbcopy', 'xclip', 'wl-copy', 'dd', 'ln', 'mv']);
const WRITERS = new Set(['rm', 'mv', 'cp', 'tee', 'touch', 'truncate', 'sed', 'perl', 'chmod', 'chown', 'chgrp', 'ln', 'install', 'mkdir',
  'rmdir', 'dd', 'shred', 'unlink', 'rsync', 'scp', 'patch', 'vim', 'vi', 'nano', 'emacs']);
const OUT_REDIRS = new Set(['>', '>>', '>|', '&>', '&>>', '<>']);

// ---------------------------------------------------------------- loading

export function stripJsonComments(text) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\') { out += text[++i] ?? ''; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && text[i + 1] === '*') { const j = text.indexOf('*/', i + 2); i = j < 0 ? text.length : j + 1; continue; }
    out += c;
  }
  // trailing commas
  return out.replace(/,(\s*[\]}])/g, '$1');
}

export function readJsonc(file) {
  const text = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(stripJsonComments(text));
  } catch (e) {
    throw new Error(`${file}: invalid JSON (${e.message})`);
  }
}

export function presetNames() {
  return fs.readdirSync(PRESET_DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
}

export function loadPreset(name, seen = new Set()) {
  if (seen.has(name)) return { rules: [], tests: [] };
  seen.add(name);
  const file = path.join(PRESET_DIR, `${name}.json`);
  if (!fs.existsSync(file)) throw new Error(`unknown preset "${name}" (available: ${presetNames().join(', ')})`);
  const p = readJsonc(file);
  const rules = [];
  const tests = [];
  for (const parent of p.extends ?? []) {
    const sub = loadPreset(parent, seen);
    rules.push(...sub.rules); tests.push(...sub.tests);
  }
  for (const r of p.rules ?? []) rules.push({ ...r, source: `preset:${name}` });
  for (const t of p.tests ?? []) tests.push({ ...t, source: `preset:${name}` });
  return { rules, tests };
}

/** Policy files, lowest priority first. */
export function policyFiles({ projectDir, home = os.homedir() }) {
  const files = [path.join(home, '.claude', 'agentfence.json')];
  if (projectDir) files.push(path.join(projectDir, '.claude', 'agentfence.json'), path.join(projectDir, '.claude', 'agentfence.local.json'));
  return [...new Set(files)];
}

/**
 * Build the effective policy from presets and policy files.
 * @param {{files?: string[], docs?: object[], projectDir?: string, home?: string}} opts
 */
export function loadPolicy(opts = {}) {
  const docs = [];
  const files = opts.files ?? policyFiles(opts);
  for (const f of files) if (fs.existsSync(f)) docs.push({ ...readJsonc(f), file: f });
  for (const d of opts.docs ?? []) docs.push(d);
  return buildPolicy(docs);
}

export function buildPolicy(docs) {
  const extendsSet = new Set();
  let anyExtends = false;
  const disable = new Set();
  const userRules = [];
  const tests = [];
  for (const d of docs) {
    const where = d.file ?? 'policy';
    for (const k of Object.keys(d)) if (!['extends', 'disable', 'rules', 'tests', 'file', '$schema'].includes(k)) throw new Error(`${where}: unknown key "${k}"`);
    if (d.extends !== undefined) { anyExtends = true; for (const e of [].concat(d.extends)) extendsSet.add(e); }
    for (const id of d.disable ?? []) disable.add(id);
    for (const r of d.rules ?? []) userRules.push({ ...r, source: where });
    for (const t of d.tests ?? []) tests.push({ ...t, source: where });
  }
  const presets = anyExtends ? [...extendsSet] : DEFAULT_EXTENDS;
  const byId = new Map();
  const order = [];
  const add = (r) => {
    validateRule(r);
    if (!byId.has(r.id)) order.push(r.id);
    byId.set(r.id, compileRule(r));
  };
  const seen = new Set();
  for (const name of presets) for (const r of loadPreset(name, seen).rules) add(r);
  let n = 0;
  for (const r of userRules) add({ id: r.id ?? `rule-${++n}`, ...r });
  const rules = order.filter((id) => !disable.has(id)).map((id) => byId.get(id));
  return { presets, rules, tests, disabled: [...disable] };
}

function validateRule(r) {
  const where = `${r.source}: rule "${r.id ?? '?'}"`;
  for (const k of Object.keys(r)) if (k !== 'source' && !RULE_KEYS.has(k)) throw new Error(`${where}: unknown key "${k}"`);
  if (!['deny', 'ask', 'allow'].includes(r.decision)) throw new Error(`${where}: "decision" must be "deny", "ask" or "allow"`);
  if (!MATCH_KEYS.some((k) => r[k] !== undefined)) throw new Error(`${where}: needs one of ${MATCH_KEYS.join(', ')}`);
  if (r.pipe !== undefined && (!Array.isArray(r.pipe) || r.pipe.length !== 2)) throw new Error(`${where}: "pipe" must be [producer, consumer]`);
  for (const rx of [].concat(r.bashRegex ?? [])) {
    try { new RegExp(rx, 'i'); } catch (e) { throw new Error(`${where}: bad bashRegex: ${e.message}`); }
  }
}

const list = (v) => (v === undefined ? [] : [].concat(v));

function compileRule(r) {
  return {
    ...r,
    bash: list(r.bash).map(compileCommandPattern),
    bashRegex: list(r.bashRegex).map((s) => new RegExp(s, 'i')),
    read: list(r.read),
    write: list(r.write),
    tool: list(r.tool),
    pipe: r.pipe ? r.pipe.map(compileCommandPattern) : null,
    unless: r.unless ? compileRule({ ...r.unless, decision: 'allow' }) : null,
    when: r.when ?? null,
    raw: r,
  };
}

// ---------------------------------------------------------------- command patterns
//
// "git push {-f,--force}"  -> command `git`, positional `push`, flag `-f` or `--force`
// Positionals must appear in order (other arguments may sit in between).
// Flags may appear anywhere. A one-letter flag such as `-r` also matches
// combined flags like `-rf`. Long flags also match `--flag=value`.

export function compileCommandPattern(src) {
  const tokens = src.trim().split(/\s+/);
  const [cmd, ...rest] = tokens;
  const flags = [];
  const positionals = [];
  for (const t of rest) {
    const alts = expandBraces(t);
    if (alts.every((a) => a.startsWith('-') && a.length > 1)) flags.push(alts);
    else positionals.push(t);
  }
  return { src, cmd, flags, positionals };
}

function splitArgv(argv) {
  const flags = [];
  const positionals = [];
  let dd = false;
  for (const a of argv.slice(1)) {
    if (!dd && a === '--') { dd = true; continue; }
    if (!dd && a.startsWith('-') && a.length > 1) flags.push(a);
    else positionals.push(a);
  }
  return { flags, positionals };
}

function flagMatches(alt, flag) {
  if (/^-[A-Za-z0-9]$/.test(alt)) {
    if (flag === alt) return true;
    return /^-[A-Za-z0-9]+$/.test(flag) && !flag.startsWith('--') && flag.includes(alt[1]);
  }
  if (hasGlob(alt)) return globToRegExp(alt).test(flag);
  return flag === alt || flag.startsWith(alt + '=');
}

export function matchCommand(pat, argv, env) {
  if (!argv.length) return false;
  const name = argv[0].split('/').pop();
  if (!matchToken(pat.cmd, name) && !matchToken(pat.cmd, argv[0])) return false;
  const { flags, positionals } = splitArgv(argv);
  for (const alts of pat.flags) if (!flags.some((f) => alts.some((a) => flagMatches(a, f)))) return false;
  let i = 0;
  for (const p of pat.positionals) {
    const want = expandBraces(p).map((g) => normalizePath(expandWord(g, env)));
    while (i < positionals.length && !want.some((g) => globToRegExp(g).test(normalizePath(expandWord(positionals[i], env))))) i++;
    if (i >= positionals.length) return false;
    i++;
  }
  return true;
}

// ---------------------------------------------------------------- evaluation

export function gitBranch(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/**
 * Turn a PreToolUse payload into a list of subjects to check.
 * A subject is { kind: 'bash'|'read'|'write'|'tool', ... }.
 */
function subjectsFor(input, ctx) {
  const tool = input.tool_name;
  const ti = input.tool_input ?? {};
  const out = [{ kind: 'tool', name: tool, cwd: ctx.cwd }];
  const rawPath = ti.file_path ?? ti.notebook_path;
  const filePath = rawPath && expandWord(rawPath, { home: ctx.home, cwd: ctx.cwd });
  if (tool === 'Bash' && typeof ti.command === 'string') {
    out.push({ kind: 'script', script: ti.command, cwd: ctx.cwd });
  } else if (['Read'].includes(tool) && filePath) {
    out.push({ kind: 'read', path: resolvePath(filePath, ctx.cwd), cwd: ctx.cwd });
  } else if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool) && filePath) {
    out.push({ kind: 'write', path: resolvePath(filePath, ctx.cwd), cwd: ctx.cwd });
  } else if (['Grep', 'Glob'].includes(tool) && ti.path) {
    out.push({ kind: 'read', path: resolvePath(expandWord(ti.path, { home: ctx.home, cwd: ctx.cwd }), ctx.cwd), cwd: ctx.cwd });
  }
  return out;
}

/**
 * Evaluate a PreToolUse payload against a policy.
 * @returns {{decision: 'deny'|'ask'|'allow'|'none', matches: object[], commands?: object[], error?: string}}
 */
export function evaluate(policy, input, opts = {}) {
  const home = opts.home ?? os.homedir();
  const cwd = input.cwd ?? process.cwd();
  const projectDir = opts.projectDir ?? cwd;
  const branchOf = opts.branchOf ?? gitBranch;
  const ctx = { home, cwd, projectDir, branchOf, branchCache: new Map() };
  const matches = [];
  let commands;
  let allowCovered = true;
  let allowAny = false;

  for (const subject of subjectsFor(input, ctx)) {
    if (subject.kind !== 'script') {
      const m = matchSubject(policy, subject, ctx);
      matches.push(...m);
      if (subject.kind !== 'tool') { if (m.some((x) => x.decision === 'allow')) allowAny = true; else allowCovered = false; }
      continue;
    }
    try {
      commands = withCwd(parse(subject.script).commands, cwd, home);
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      return { decision: 'ask', matches: [{ ruleId: 'parse-error', decision: 'ask', reason: `agentfence could not parse this command (${e.message}), so it cannot vouch for it` }], error: e.message };
    }
    const sm = matchScript(policy, commands, subject.script, ctx);
    matches.push(...sm.matches);
    if (!sm.allCovered) allowCovered = false;
    if (sm.anyAllow) allowAny = true;
  }

  let decision = 'none';
  for (const m of matches) if (m.decision !== 'allow' && RANK[m.decision] > RANK[decision]) decision = m.decision;
  if (decision === 'none') {
    const toolAllow = matches.some((m) => m.decision === 'allow' && m.kind === 'tool');
    if ((allowAny && allowCovered) || (toolAllow && allowCovered)) decision = 'allow';
  }
  return { decision, matches, commands };
}

// Track `cd dir` so later commands in the same line get the right working directory.
function withCwd(commands, cwd, home) {
  let cur = cwd;
  for (const c of commands) {
    c.cwd = cur;
    if (c.depth === 0 && c.argv[0] === 'cd' && c.argv.length <= 2) {
      const target = c.argv[1] ?? '~';
      if (!target.includes('$') && target !== '-') cur = resolvePath(expandWord(target, { home }), cur);
    }
    if (c.depth === 0 && c.argv[0] === 'git') {
      const i = c.argv.indexOf('-C');
      if (i > 0 && c.argv[i + 1]) c.gitDir = resolvePath(expandWord(c.argv[i + 1], { home }), cur);
    }
  }
  return commands;
}

function whenOk(rule, subject, ctx) {
  const w = rule.when;
  if (!w) return true;
  const dir = subject.gitDir ?? subject.cwd ?? ctx.cwd;
  if (w.cwd !== undefined && !list(w.cwd).some((g) => matchPath(g, dir, ctx))) return false;
  if (w.branch !== undefined) {
    if (!ctx.branchCache.has(dir)) ctx.branchCache.set(dir, ctx.branchOf(dir));
    const b = ctx.branchCache.get(dir);
    if (b == null || !list(w.branch).some((g) => matchToken(g, b))) return false;
  }
  return true;
}

function ruleHits(rule, subject, ctx) {
  // Returns a human-readable description of what matched, or null.
  switch (subject.kind) {
    case 'tool':
      return rule.tool.some((g) => matchToken(g, subject.name, { ignoreCase: true })) ? subject.name : null;
    case 'read':
    case 'write': {
      const globs = subject.kind === 'read' ? rule.read : [...rule.write];
      return globs.some((g) => matchPath(g, subject.path, ctx)) ? subject.path : null;
    }
    case 'command': {
      const env = { home: ctx.home, cwd: subject.cwd };
      if (rule.bash.some((p) => matchCommand(p, subject.argv, env))) return subject.text;
      if (rule.bashRegex.some((rx) => rx.test(subject.text))) return subject.text;
      for (const p of subject.paths) {
        if (p.mode === 'read' && rule.read.some((g) => matchPath(g, p.path, ctx))) return `${subject.text}  (reads ${p.path})`;
        if (p.mode === 'write' && rule.write.some((g) => matchPath(g, p.path, ctx))) return `${subject.text}  (writes ${p.path})`;
      }
      return null;
    }
    default:
      return null;
  }
}

function matchSubject(policy, subject, ctx) {
  const out = [];
  for (const rule of policy.rules) {
    const hit = ruleHits(rule, subject, ctx);
    if (hit == null) continue;
    if (rule.unless && ruleHits(rule.unless, subject, ctx) != null) continue;
    if (!whenOk(rule, subject, ctx)) continue;
    out.push({ ruleId: rule.id, decision: rule.decision, reason: rule.reason ?? '', subject: hit, source: rule.source, kind: subject.kind });
  }
  return out;
}

const quote = (a) => {
  if (/^[A-Za-z0-9_@%+=:,./~-]+$/.test(a)) return a;
  if (!a.includes("'")) return `'${a}'`;
  if (!/["$`\\]/.test(a)) return `"${a}"`;
  return `'${a.replace(/'/g, `'\\''`)}'`;
};

function commandSubject(c, ctx) {
  const text = c.argv.map(quote).join(' ');
  const name = (c.argv[0] ?? '').split('/').pop();
  const paths = [];
  const exp = (p) => resolvePath(expandWord(p, { home: ctx.home, cwd: c.cwd }), c.cwd);
  const { positionals, flags } = splitArgv(c.argv);
  const vals = [...positionals, ...flags.filter((f) => f.includes('=')).map((f) => f.slice(f.indexOf('=') + 1))];
  const isSedInPlace = name === 'sed' || name === 'perl' ? flags.some((f) => /^-[a-zA-Z]*i/.test(f) || f.startsWith('--in-place')) : true;
  // `curl -F file=@~/.aws/credentials`, `--data=@.env`, `of=/dev/sda`: also look after `@` and `=`.
  for (const v of [...vals]) {
    if (v.includes('@')) vals.push(v.slice(v.lastIndexOf('@') + 1));
    if (v.includes('=')) vals.push(v.slice(v.indexOf('=') + 1));
  }
  for (const v of new Set(vals)) {
    if (!v || v.includes('$(') || v.startsWith('-')) continue;
    if (READERS.has(name)) paths.push({ mode: 'read', path: exp(v) });
    if (WRITERS.has(name) && isSedInPlace) paths.push({ mode: 'write', path: exp(v) });
  }
  for (const r of c.redirects) {
    if (!r.target || /^[0-9-]$/.test(r.target)) continue;
    if (OUT_REDIRS.has(r.op)) paths.push({ mode: 'write', path: exp(r.target) });
    if (r.op === '<' || r.op === '<>') paths.push({ mode: 'read', path: exp(r.target) });
  }
  return { kind: 'command', argv: c.argv, text: text || c.redirects.map((r) => `${r.op}${r.target}`).join(' '), paths, cwd: c.cwd, gitDir: c.gitDir };
}

function matchScript(policy, commands, script, ctx) {
  const matches = [];
  let allCovered = true;
  let anyAllow = false;
  const subjects = commands.map((c) => commandSubject(c, ctx));
  subjects.forEach((s) => {
    const m = matchSubject(policy, s, ctx);
    matches.push(...m);
    // Auto-approve only when every single command matched an allow rule.
    if (m.some((x) => x.decision === 'allow')) anyAllow = true;
    else allCovered = false;
  });
  // Pipe rules: producer earlier in the same pipeline than consumer.
  for (const rule of policy.rules) {
    if (!rule.pipe) continue;
    const [prod, cons] = rule.pipe;
    for (const a of commands) {
      if (!matchCommand(prod, a.argv, { home: ctx.home, cwd: a.cwd })) continue;
      const b = commands.find((b) => b.pipeline === a.pipeline && b.stage > a.stage && matchCommand(cons, b.argv, { home: ctx.home, cwd: b.cwd }));
      if (!b) continue;
      if (!whenOk(rule, { cwd: a.cwd }, ctx)) continue;
      matches.push({ ruleId: rule.id, decision: rule.decision, reason: rule.reason ?? '', subject: `${a.argv.map(quote).join(' ')} | ${b.argv.map(quote).join(' ')}`, source: rule.source, kind: 'pipe' });
      break;
    }
  }
  if (!commands.length) allCovered = false;
  return { matches, allCovered, anyAllow };
}

/** Render the hook reply for Claude Code. */
export function hookReply(result) {
  if (result.decision === 'none') return null;
  const shown = result.matches.filter((m) => m.decision === result.decision);
  const reason = shown
    .map((m) => `agentfence [${m.ruleId}]: ${m.reason || 'blocked by policy'}${m.subject ? ` (matched: ${m.subject})` : ''}`)
    .join('\n');
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: result.decision,
      permissionDecisionReason: reason,
    },
  };
}
