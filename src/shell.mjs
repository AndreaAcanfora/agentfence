// A small POSIX-ish shell parser.
//
// It does not execute anything. It turns a command line into the list of
// simple commands that would run, so that policies can be matched against
// real argv arrays instead of raw strings. It understands quoting, escapes,
// operators, redirections, heredocs, command substitution, and the usual
// wrappers (sudo, env, xargs, bash -c, eval, find -exec, ssh, ...).

export class ParseError extends Error {}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish', 'busybox']);
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', '!', '{', '}', 'esac', 'time']);
const SKIP_SEGMENT = new Set(['for', 'case', 'select', 'function']);
const MAX_DEPTH = 8;

// ---------------------------------------------------------------- lexer

function scanBalanced(src, i, open, close) {
  // src[i] is just after the opening delimiter. Returns index of the matching close.
  let depth = 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      if (j < 0) throw new ParseError('unterminated single quote');
      i = j + 1; continue;
    }
    if (c === '"') { i = scanDouble(src, i + 1).end; continue; }
    if (c === '`') { i = scanBacktick(src, i + 1) + 1; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return i; }
    i++;
  }
  throw new ParseError(`unterminated ${open}`);
}

function scanBacktick(src, i) {
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === '`') return i;
    i++;
  }
  throw new ParseError('unterminated backtick');
}

// Scan a dollar expression starting at src[i] === '$'.
// Returns { end, text, sub } where sub is a nested script (or null).
function scanDollar(src, i) {
  const n = src[i + 1];
  if (n === '(' && src[i + 2] === '(') {
    const end = scanBalanced(src, i + 3, '(', ')');
    if (src[end + 1] !== ')') throw new ParseError('unterminated $((');
    return { end: end + 2, text: src.slice(i, end + 2), sub: null };
  }
  if (n === '(') {
    const end = scanBalanced(src, i + 2, '(', ')');
    return { end: end + 1, text: src.slice(i, end + 1), sub: src.slice(i + 2, end) };
  }
  if (n === '{') {
    const end = scanBalanced(src, i + 2, '{', '}');
    return { end: end + 1, text: src.slice(i, end + 1), sub: null };
  }
  let j = i + 1;
  if (/[A-Za-z_]/.test(src[j] || '')) { while (/[A-Za-z0-9_]/.test(src[j] || '')) j++; }
  else if (/[0-9@*#?$!-]/.test(src[j] || '')) j++;
  return { end: j, text: src.slice(i, j), sub: null };
}

function scanDouble(src, i) {
  // src[i] is just after the opening ". Returns { end (after closing "), value, subs }
  let value = '';
  const subs = [];
  while (i < src.length) {
    const c = src[i];
    if (c === '"') return { end: i + 1, value, subs };
    if (c === '\\') {
      const n = src[i + 1];
      if (n === '\n') { i += 2; continue; }
      if ('$`"\\'.includes(n)) { value += n; i += 2; continue; }
      value += c; i++; continue;
    }
    if (c === '$') {
      const d = scanDollar(src, i);
      value += d.text; if (d.sub != null) subs.push(d.sub); i = d.end; continue;
    }
    if (c === '`') {
      const end = scanBacktick(src, i + 1);
      subs.push(src.slice(i + 1, end)); value += src.slice(i, end + 1); i = end + 1; continue;
    }
    value += c; i++;
  }
  throw new ParseError('unterminated double quote');
}

function ansiC(s) {
  return s.replace(/\\(x[0-9a-fA-F]{1,2}|[0-7]{1,3}|.)/g, (_, e) => {
    if (e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
    if (/^[0-7]+$/.test(e)) return String.fromCharCode(parseInt(e, 8));
    return { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', f: '\f', v: '\v' }[e] ?? e;
  });
}

const OPS = ['&&', '||', ';;', '|&', ';', '|', '&', '(', ')'];
const REDIRS = ['&>>', '<<<', '<<-', '>>', '<<', '>&', '<&', '>|', '<>', '&>', '>', '<'];

export function lex(src) {
  const tokens = [];
  const pendingHeredocs = [];
  let i = 0;
  let word = null; // { value, subs, quoted, raw start }

  const flush = () => {
    if (word) { tokens.push({ type: 'word', value: word.value, subs: word.subs, quoted: word.quoted, quoteAt: word.quoteAt }); word = null; }
  };
  const w = () => (word ??= { value: '', subs: [], quoted: false, quoteAt: Infinity });
  const q = () => { const x = w(); if (!x.quoted) { x.quoted = true; x.quoteAt = x.value.length; } return x; };

  while (i < src.length) {
    const c = src[i];

    if (c === '\\') {
      if (src[i + 1] === '\n') { i += 2; continue; }
      if (i + 1 >= src.length) { i++; continue; }
      q().value += src[i + 1]; i += 2; continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') { flush(); i++; continue; }
    if (c === '\n') {
      flush();
      tokens.push({ type: 'op', value: '\n' });
      i++;
      // Read heredoc bodies that start after this newline.
      while (pendingHeredocs.length) {
        const h = pendingHeredocs.shift();
        const lines = [];
        let found = false;
        while (i <= src.length) {
          let nl = src.indexOf('\n', i);
          if (nl < 0) nl = src.length;
          let line = src.slice(i, nl);
          i = nl + 1;
          const cmp = h.stripTabs ? line.replace(/^\t+/, '') : line;
          if (cmp === h.delim) { found = true; break; }
          lines.push(h.stripTabs ? cmp : line);
          if (nl >= src.length) break;
        }
        h.token.body = lines.join('\n');
        if (!found) h.token.unterminated = true;
      }
      continue;
    }
    if (c === '#' && !word) {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      if (j < 0) throw new ParseError('unterminated single quote');
      q().value += src.slice(i + 1, j); i = j + 1; continue;
    }
    if (c === '$' && src[i + 1] === "'") {
      let j = i + 2;
      while (j < src.length && src[j] !== "'") j += src[j] === '\\' ? 2 : 1;
      if (j >= src.length) throw new ParseError("unterminated $'");
      q().value += ansiC(src.slice(i + 2, j)); i = j + 1; continue;
    }
    if (c === '"') {
      const d = scanDouble(src, i + 1);
      q().value += d.value; w().subs.push(...d.subs); i = d.end; continue;
    }
    if (c === '$') {
      const d = scanDollar(src, i);
      w().value += d.text; if (d.sub != null) w().subs.push(d.sub); i = d.end; continue;
    }
    if (c === '`') {
      const end = scanBacktick(src, i + 1);
      w().subs.push(src.slice(i + 1, end)); w().value += src.slice(i, end + 1); i = end + 1; continue;
    }

    // Process substitution <(...) and >(...)
    if ((c === '<' || c === '>') && src[i + 1] === '(') {
      const end = scanBalanced(src, i + 2, '(', ')');
      w().subs.push(src.slice(i + 2, end)); w().value += src.slice(i, end + 1); i = end + 1; continue;
    }

    // Redirections, optionally preceded by an fd number (2>, 1>>, ...)
    const redir = REDIRS.find((r) => src.startsWith(r, i));
    if (redir) {
      let fd = null;
      if (word && /^[0-9]+$/.test(word.value) && !word.quoted && !word.subs.length) { fd = word.value; word = null; }
      flush();
      i += redir.length;
      // read target word
      while (src[i] === ' ' || src[i] === '\t') i++;
      const sub = lex1(src, i);
      i = sub.end;
      const tok = { type: 'redir', op: redir, fd, target: sub.value, subs: sub.subs };
      tokens.push(tok);
      if (redir === '<<' || redir === '<<-') {
        pendingHeredocs.push({ delim: sub.value, stripTabs: redir === '<<-', token: tok });
      }
      continue;
    }

    const op = OPS.find((o) => src.startsWith(o, i));
    if (op && !((op === '(' || op === ')') && word)) {
      flush();
      tokens.push({ type: 'op', value: op === ';;' ? ';' : op });
      i += op.length;
      continue;
    }
    if ((c === '(' || c === ')') && word) {
      // e.g. arr=(a b) or func(): keep as part of the word
      w().value += c; i++; continue;
    }

    w().value += c; i++;
  }
  flush();
  if (pendingHeredocs.length) {
    for (const h of pendingHeredocs) { h.token.body = ''; h.token.unterminated = true; }
  }
  return tokens;
}

// Lex a single word starting at i (used for redirection targets).
function lex1(src, i) {
  let value = '';
  const subs = [];
  while (i < src.length) {
    const c = src[i];
    if (' \t\n;&|()<>'.includes(c)) break;
    if (c === '\\') { value += src[i + 1] ?? ''; i += 2; continue; }
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      if (j < 0) throw new ParseError('unterminated single quote');
      value += src.slice(i + 1, j); i = j + 1; continue;
    }
    if (c === '"') { const d = scanDouble(src, i + 1); value += d.value; subs.push(...d.subs); i = d.end; continue; }
    if (c === '$') { const d = scanDollar(src, i); value += d.text; if (d.sub != null) subs.push(d.sub); i = d.end; continue; }
    if (c === '`') { const end = scanBacktick(src, i + 1); subs.push(src.slice(i + 1, end)); value += src.slice(i, end + 1); i = end + 1; continue; }
    value += c; i++;
  }
  return { value, subs, end: i };
}

// ---------------------------------------------------------------- parser

const basename = (p) => p.replace(/\/+$/, '').split('/').pop();

/**
 * Parse a command line into simple commands.
 * @returns {{ commands: Command[] }}
 *
 * Command: {
 *   argv: string[], redirects: {op, fd, target, body?}[],
 *   pipeline: number, stage: number, depth: number,
 *   via: string[]   // wrappers that were peeled off, e.g. ['sudo'], ['bash -c']
 * }
 */
export function parse(src, depth = 0, via = [], counter = { pipeline: 0 }) {
  if (depth > MAX_DEPTH) throw new ParseError('nesting too deep');
  const tokens = lex(src);
  const commands = [];

  let seg = { words: [], redirects: [] };
  let stage = 0;
  let pipeline = counter.pipeline++;

  const endSegment = () => {
    if (seg.words.length || seg.redirects.length) {
      emitSegment(seg, { pipeline, stage, depth, via }, commands, counter);
    }
    seg = { words: [], redirects: [] };
  };

  for (const t of tokens) {
    if (t.type === 'word') seg.words.push(t);
    else if (t.type === 'redir') seg.redirects.push(t);
    else if (t.value === '|' || t.value === '|&') { endSegment(); stage++; }
    else { endSegment(); stage = 0; pipeline = counter.pipeline++; }
  }
  endSegment();
  return { commands };
}

function emitSegment(seg, ctx, out, counter) {
  let words = seg.words;
  // Nested scripts from command substitution, anywhere in the segment.
  for (const w of words) for (const s of w.subs) pushNested(s, ctx, out, counter, '$()');
  for (const r of seg.redirects) for (const s of r.subs) pushNested(s, ctx, out, counter, '$()');

  // Strip leading keywords and assignments.
  const env = {};
  let k = 0;
  while (k < words.length) {
    const v = words[k].value;
    if (!words[k].quoted && KEYWORDS.has(v)) { k++; continue; }
    const assign = /^[A-Za-z_][A-Za-z0-9_]*\+?=/.exec(v);
    if (assign && assign[0].length <= words[k].quoteAt) {
      const eq = v.indexOf('=');
      env[v.slice(0, eq).replace(/\+$/, '')] = v.slice(eq + 1);
      k++; continue;
    }
    break;
  }
  words = words.slice(k);
  if (words.length && !words[0].quoted && SKIP_SEGMENT.has(words[0].value)) return;
  // A trailing "}" or "done" is noise.
  while (words.length && !words.at(-1).quoted && (words.at(-1).value === '}')) words.pop();

  const argv = words.map((w) => w.value);
  const redirects = seg.redirects.map((r) => ({ op: r.op, fd: r.fd, target: r.target, body: r.body }));
  if (!argv.length && !redirects.length) return;

  const cmd = { argv, redirects, env, pipeline: ctx.pipeline, stage: ctx.stage, depth: ctx.depth, via: ctx.via };
  out.push(cmd);
  if (argv.length) unwrap(cmd, ctx, out, counter);
}

function pushNested(script, ctx, out, counter, how) {
  const r = parse(script, ctx.depth + 1, [...ctx.via, how], counter);
  out.push(...r.commands);
}

// Options that take a separate value, per wrapper.
const ARG_OPTS = {
  sudo: new Set(['-u', '-g', '-p', '-C', '-D', '-h', '-r', '-t', '-U', '-T', '--user', '--group', '--prompt', '--chdir']),
  doas: new Set(['-u', '-C']),
  env: new Set(['-u', '-C', '--unset', '--chdir']),
  exec: new Set(['-a']),
  nice: new Set(['-n', '--adjustment']),
  ionice: new Set(['-c', '-n', '-p', '-t']),
  timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
  stdbuf: new Set(['-i', '-o', '-e']),
  xargs: new Set(['-I', '-n', '-P', '-L', '-d', '-E', '-s', '-a', '--max-args', '--max-procs', '--delimiter', '--arg-file', '--replace']),
  watch: new Set(['-n', '-d', '--interval']),
  ssh: new Set(['-p', '-i', '-l', '-o', '-F', '-J', '-L', '-R', '-D', '-b', '-c', '-e', '-m', '-O', '-Q', '-S', '-W', '-w', '-E', '-B', '-I']),
  time: new Set(['-f', '-o']),
  nohup: new Set(),
  command: new Set(),
  builtin: new Set(),
  chronic: new Set(),
  caffeinate: new Set(['-t', '-w']),
  npx: new Set(['-p', '--package', '-c', '--call', '--with', '--from', '--python', '-w', '--workspace']),
};

const RUNNER_SUBCOMMANDS = {
  pnpm: ['exec', 'dlx'], yarn: ['exec', 'dlx'], bundle: ['exec'], poetry: ['run'], uv: ['run'], pipenv: ['run'], pdm: ['run'], hatch: ['run'],
};

// Skip options of a wrapper; returns index of first non-option argument.
function skipOpts(argv, start, argOpts) {
  let i = start;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--') return i + 1;
    if (!a.startsWith('-') || a === '-') break;
    if (argOpts.has(a)) { i += 2; continue; }
    if (a.startsWith('--') && a.includes('=')) { i++; continue; }
    i++;
  }
  return i;
}

function child(cmd, argv, wrapper, extra = {}) {
  return { argv, redirects: extra.redirects ?? [], env: cmd.env, pipeline: cmd.pipeline, stage: cmd.stage, depth: cmd.depth + 1, via: [...cmd.via, wrapper] };
}

function unwrap(cmd, ctx, out, counter) {
  const argv = cmd.argv;
  const name = basename(argv[0]);
  const nestedScript = (script, how) => {
    const r = parse(script, cmd.depth + 1, [...cmd.via, how], counter);
    out.push(...r.commands);
  };
  const push = (rest, how) => {
    if (!rest.length) return;
    const c = child(cmd, rest, how, { redirects: cmd.redirects });
    out.push(c);
    unwrap(c, ctx, out, counter);
  };

  switch (name) {
    case 'sudo': case 'doas': case 'nohup': case 'builtin': case 'exec': case 'nice': case 'ionice':
    case 'stdbuf': case 'time': case 'chronic': case 'caffeinate': {
      const i = skipOpts(argv, 1, ARG_OPTS[name]);
      return push(argv.slice(i), name);
    }
    case 'command': {
      if (argv.slice(1).some((a) => a === '-v' || a === '-V')) return;
      return push(argv.slice(skipOpts(argv, 1, ARG_OPTS.command)), name);
    }
    case 'env': {
      let i = 1;
      while (i < argv.length) {
        const a = argv[i];
        if (a === '-S' || a === '--split-string') { return nestedScript(argv.slice(i + 1).join(' '), 'env -S'); }
        if (a.startsWith('-S') && a.length > 2) { return nestedScript([a.slice(2), ...argv.slice(i + 1)].join(' '), 'env -S'); }
        if (a === '--') { i++; break; }
        if (ARG_OPTS.env.has(a)) { i += 2; continue; }
        if (a.startsWith('-') && a !== '-') { i++; continue; }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) { i++; continue; }
        break;
      }
      return push(argv.slice(i), 'env');
    }
    case 'timeout': {
      const i = skipOpts(argv, 1, ARG_OPTS.timeout);
      return push(argv.slice(i + 1), 'timeout');
    }
    case 'xargs': {
      const i = skipOpts(argv, 1, ARG_OPTS.xargs);
      return push(argv.slice(i), 'xargs');
    }
    case 'watch': {
      const i = skipOpts(argv, 1, ARG_OPTS.watch);
      if (i < argv.length) nestedScript(argv.slice(i).join(' '), 'watch');
      return;
    }
    case 'eval': {
      if (argv.length > 1) nestedScript(argv.slice(1).join(' '), 'eval');
      return;
    }
    case 'ssh': {
      const i = skipOpts(argv, 1, ARG_OPTS.ssh);
      if (argv.length > i + 1) nestedScript(argv.slice(i + 1).join(' '), 'ssh');
      return;
    }
    case 'find': {
      for (let i = 1; i < argv.length; i++) {
        if (['-exec', '-execdir', '-ok', '-okdir'].includes(argv[i])) {
          let j = i + 1;
          while (j < argv.length && argv[j] !== ';' && argv[j] !== '+') j++;
          push(argv.slice(i + 1, j), `find ${argv[i]}`);
          i = j;
        }
      }
      return;
    }
    case 'npx': case 'bunx': case 'pnpx': case 'uvx': {
      const i = skipOpts(argv, 1, ARG_OPTS.npx);
      return push(argv.slice(i), name);
    }
    case 'pnpm': case 'yarn': case 'bundle': case 'poetry': case 'uv': case 'pipenv': case 'pdm': case 'hatch': {
      // pnpm exec / yarn dlx / bundle exec / poetry run / uv run ...
      const i = skipOpts(argv, 1, new Set());
      if (RUNNER_SUBCOMMANDS[name].includes(argv[i])) return push(argv.slice(skipOpts(argv, i + 1, ARG_OPTS.npx)), `${name} ${argv[i]}`);
      return;
    }
    default:
      break;
  }

  if (SHELLS.has(name)) {
    let i = 1;
    if (name === 'busybox') { if (!SHELLS.has(argv[1] ?? '')) return push(argv.slice(1), 'busybox'); i = 2; }
    for (; i < argv.length; i++) {
      const a = argv[i];
      if (a === '-c' || (/^-[a-zA-Z]+$/.test(a) && a.includes('c') && !a.startsWith('--'))) {
        if (i + 1 < argv.length) nestedScript(argv[i + 1], `${name} -c`);
        return;
      }
      if (a === '--command') { if (i + 1 < argv.length) nestedScript(argv[i + 1], `${name} -c`); return; }
      if (!a.startsWith('-')) break;
    }
    // Heredoc fed to a shell: the body is a script.
    for (const r of cmd.redirects) {
      if ((r.op === '<<' || r.op === '<<-') && r.body) nestedScript(r.body, `${name} <<`);
      if (r.op === '<<<' && r.target) nestedScript(r.target, `${name} <<<`);
    }
  }
}
