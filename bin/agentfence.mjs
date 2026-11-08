#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPolicy, loadPreset, presetNames, evaluate, hookReply, policyFiles, gitBranch } from '../src/policy.mjs';
import { runTests, describeTest, payloadFor } from '../src/testing.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const PRESET_DIR = path.join(ROOT, 'src', 'presets');

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const red = paint('31;1'), yellow = paint('33;1'), green = paint('32;1'), dim = paint('2'), bold = paint('1');
const badge = { deny: red('DENY'), ask: yellow('ASK'), allow: green('ALLOW'), none: dim('PASS') };

const HELP = `agentfence ${VERSION} - a policy firewall for Claude Code

Usage:
  agentfence check [options] -- <command>   Show what the policy decides for a shell command
  agentfence check --read <path>            ... for reading a file (also --write <path>, --tool <name>)
  agentfence test [--presets]               Run the "tests" in your policy files (and the built-in presets)
  agentfence init [--force]                 Create .claude/agentfence.json in the current project
  agentfence rules                          List the rules in effect here
  agentfence presets                        List built-in presets
  agentfence log [-n 20]                    Show recent denied / asked actions
  agentfence hook                           PreToolUse hook entry point (reads JSON on stdin)

Options for check:
  --cwd <dir>       Working directory to evaluate in (default: current)
  --branch <name>   Pretend the current git branch is <name>
  --json            Print the raw result as JSON

Policy files (merged in this order):
  ~/.claude/agentfence.json, <project>/.claude/agentfence.json, <project>/.claude/agentfence.local.json
`;

function auditFile() {
  const dir = process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.claude', 'agentfence');
  return path.join(dir, 'audit.jsonl');
}

function audit(entry) {
  try {
    const f = auditFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify(entry) + '\n');
  } catch {
    // Auditing must never break the hook.
  }
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function hook() {
  let input;
  try {
    input = JSON.parse(readStdin() || '{}');
  } catch (e) {
    return reply({ decision: 'ask', matches: [{ ruleId: 'agentfence-error', decision: 'ask', reason: `could not read hook input: ${e.message}` }] });
  }
  const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  let result;
  try {
    const policy = loadPolicy({ projectDir });
    result = evaluate(policy, input, { projectDir });
  } catch (e) {
    // Fail closed, but let the human decide instead of blocking everything.
    result = { decision: 'ask', matches: [{ ruleId: 'agentfence-error', decision: 'ask', reason: `policy error: ${e.message}` }] };
  }
  if (result.decision === 'deny' || result.decision === 'ask') {
    audit({
      time: new Date().toISOString(),
      decision: result.decision,
      rules: [...new Set(result.matches.filter((m) => m.decision === result.decision).map((m) => m.ruleId))],
      tool: input.tool_name,
      input: input.tool_name === 'Bash' ? input.tool_input?.command : input.tool_input?.file_path ?? input.tool_name,
      cwd: input.cwd,
      session: input.session_id,
    });
  }
  return reply(result);
}

function reply(result) {
  const out = hookReply(result);
  if (out) process.stdout.write(JSON.stringify(out) + '\n');
  return 0;
}

function parseArgs(argv, spec) {
  const opts = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { rest.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('-') && a in spec) {
      if (spec[a]) { opts[spec[a]] = argv[++i]; } else opts[a.replace(/^-+/, '')] = true;
    } else if (a.startsWith('-') && a.includes('=') && a.split('=')[0] in spec) {
      opts[spec[a.split('=')[0]]] = a.slice(a.indexOf('=') + 1);
    } else rest.push(a);
  }
  return { opts, rest };
}

const shellQuote = (a) => {
  if (/^[A-Za-z0-9_@%+=:,./~-]+$/.test(a)) return a;
  if (!a.includes("'")) return `'${a}'`;
  if (!/["$`\\]/.test(a)) return `"${a}"`;
  return `'${a.replace(/'/g, `'\\''`)}'`;
};

function check(argv) {
  const { opts, rest } = parseArgs(argv, { '--cwd': 'cwd', '--branch': 'branch', '--read': 'read', '--write': 'write', '--tool': 'tool', '--json': null });
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const t = { cwd };
  if (opts.read) t.read = opts.read;
  else if (opts.write) t.write = opts.write;
  else if (opts.tool) t.tool = opts.tool;
  // One argument is a whole command line; several are argv (re-quoted so `-c 'rm -rf /'` stays one word).
  else if (rest.length) t.bash = rest.length === 1 ? rest[0] : rest.map(shellQuote).join(' ');
  else { process.stderr.write('agentfence check: give a command after --, or --read / --write / --tool\n'); return 2; }

  const policy = loadPolicy({ projectDir: cwd });
  const branchOf = opts.branch ? () => opts.branch : gitBranch;
  const res = evaluate(policy, payloadFor(t, cwd), { projectDir: cwd, branchOf });
  if (opts.json) {
    process.stdout.write(JSON.stringify(res, null, 2) + '\n');
    return 0;
  }
  console.log(`${badge[res.decision]}  ${describeTest(t)}`);
  if (res.commands?.length) {
    console.log(dim('\n  parsed as:'));
    for (const c of res.commands) {
      const via = c.via.length ? dim(`   (via ${c.via.join(' → ')})`) : '';
      console.log(`    ${c.argv.map(shellQuote).join(' ')}${via}`);
    }
  }
  if (res.matches.length) {
    console.log(dim('\n  matched:'));
    for (const m of res.matches) console.log(`    ${badge[m.decision]} ${bold(m.ruleId)}  ${m.reason}${m.source ? dim(`  [${m.source}]`) : ''}`);
  } else console.log(dim('\n  no rule matched: Claude Code asks or allows as usual'));
  return 0;
}

function test(argv) {
  const { opts } = parseArgs(argv, { '--presets': null });
  const cwd = process.cwd();
  let failed = 0;
  let total = 0;
  const report = (label, policy, tests, env) => {
    const r = runTests(policy, tests, env);
    total += tests.length;
    failed += r.failures.length;
    console.log(`${r.failures.length ? red('✗') : green('✓')} ${label}: ${r.passed}/${tests.length} passed`);
    for (const f of r.failures) {
      console.log(`    ${describeTest(f.test)}`);
      console.log(`      expected ${badge[f.test.expect] ?? f.test.expect}, got ${badge[f.got]}${f.matches.length ? dim(` (${f.matches.map((m) => m.ruleId).join(', ')})`) : ''}`);
    }
  };
  const policy = loadPolicy({ projectDir: cwd });
  if (policy.tests.length) report('your policy', policy, policy.tests, { cwd, projectDir: cwd });
  else if (!opts.presets) console.log(dim('No "tests" in your policy files. Add some, e.g. { "bash": "git push --force", "expect": "deny" }'));
  if (opts.presets) {
    const env = { home: '/home/user', cwd: '/home/user/project', projectDir: '/home/user/project' };
    for (const name of presetNames()) {
      const { tests } = loadPreset(name);
      report(`preset ${name}`, loadPolicy({ files: [], docs: [{ extends: [name] }] }), tests, env);
    }
  }
  if (total) console.log(failed ? red(`\n${failed} of ${total} failed`) : green(`\nall ${total} passed`));
  return failed ? 1 : 0;
}

const TEMPLATE = `// agentfence policy for this project. Docs: https://github.com/AndreaAcanfora/agentfence
{
  "$schema": "https://raw.githubusercontent.com/AndreaAcanfora/agentfence/main/schema.json",

  // Built-in presets: destructive, git-safe, secrets, remote-exec (= "recommended"), cloud, database, publish
  "extends": ["recommended"],

  // Turn off preset rules by id (see \`agentfence rules\`)
  "disable": [],

  "rules": [
    // {
    //   "id": "no-deploy-from-agent",
    //   "decision": "deny",              // deny | ask | allow
    //   "reason": "Deploys are done by CI",
    //   "bash": "npm run deploy"
    // }
  ],

  // Run with \`agentfence test\`: proves your policy does what you think
  "tests": [
    { "bash": "git push --force origin main", "expect": "deny" },
    { "bash": "git status", "expect": "none" }
  ]
}
`;

function init(argv) {
  const { opts } = parseArgs(argv, { '--force': null });
  const file = path.join(process.cwd(), '.claude', 'agentfence.json');
  if (fs.existsSync(file) && !opts.force) {
    console.error(`${file} already exists (use --force to overwrite)`);
    return 1;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, TEMPLATE);
  console.log(`created ${file}`);
  return 0;
}

function rules() {
  const cwd = process.cwd();
  const policy = loadPolicy({ projectDir: cwd });
  const files = policyFiles({ projectDir: cwd }).filter((f) => fs.existsSync(f));
  console.log(dim(`presets: ${policy.presets.join(', ')}`));
  console.log(dim(`files:   ${files.length ? files.join(', ') : '(none, using defaults)'}`));
  if (policy.disabled.length) console.log(dim(`disabled: ${policy.disabled.join(', ')}`));
  console.log('');
  for (const r of policy.rules) console.log(`${badge[r.decision].padEnd(color ? 16 : 5)} ${bold(r.id)}  ${r.reason ?? ''} ${dim(`[${r.source}]`)}`);
  return 0;
}

function presets() {
  for (const name of presetNames()) {
    const text = fs.readFileSync(path.join(PRESET_DIR, `${name}.json`), 'utf8');
    const desc = (/^\/\/\s*(.*)$/m.exec(text) ?? [])[1] ?? '';
    const n = loadPreset(name).rules.length;
    console.log(`${bold(name.padEnd(12))} ${String(n).padStart(2)} rules  ${dim(desc)}`);
  }
  return 0;
}

function log(argv) {
  const { opts } = parseArgs(argv, { '-n': 'n' });
  const f = auditFile();
  if (!fs.existsSync(f)) { console.log(dim(`nothing logged yet (${f})`)); return 0; }
  const lines = fs.readFileSync(f, 'utf8').trim().split('\n').slice(-(Number(opts.n) || 20));
  for (const l of lines) {
    try {
      const e = JSON.parse(l);
      console.log(`${dim(e.time.replace('T', ' ').slice(0, 19))} ${badge[e.decision]} ${bold(e.rules.join(','))}  ${e.input ?? e.tool}`);
    } catch {
      // skip corrupt lines
    }
  }
  return 0;
}

const [cmd, ...args] = process.argv.slice(2);
const commands = { hook, check, test, init, rules, presets, log };
let code = 0;
try {
  if (cmd === '--version' || cmd === '-v') console.log(VERSION);
  else if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') process.stdout.write(HELP);
  else if (commands[cmd]) code = commands[cmd](args);
  else { process.stderr.write(`unknown command "${cmd}"\n\n${HELP}`); code = 2; }
} catch (e) {
  process.stderr.write(`agentfence: ${e.message}\n`);
  code = 1;
}
process.exitCode = code;
