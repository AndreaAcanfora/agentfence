import path from 'node:path';

// Expand {a,b,c} alternatives (one level of nesting is enough for policies).
export function expandBraces(p) {
  const m = /\{([^{}]*)\}/.exec(p);
  if (!m) return [p];
  const out = [];
  for (const alt of m[1].split(',')) out.push(...expandBraces(p.slice(0, m.index) + alt + p.slice(m.index + m[0].length)));
  return out;
}

const cache = new Map();

/**
 * Compile a glob (without braces) to a RegExp.
 * `*` and `?` do not cross `/`; `**` does. `\x` escapes x. `[...]` is a class.
 */
export function globToRegExp(glob, { ignoreCase = false } = {}) {
  const key = `${ignoreCase ? 'i' : ''}:${glob}`;
  if (cache.has(key)) return cache.get(key);
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '\\' && i + 1 < glob.length) { re += escape(glob[++i]); continue; }
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else if (re.endsWith('\\/') && i === glob.length - 1) {
          // "dir/**" also matches "dir" itself
          re = re.slice(0, -2) + '(?:/.*)?';
        } else re += '.*';
      } else re += '[^/]*';
      continue;
    }
    if (c === '?') { re += '[^/]'; continue; }
    if (c === '[') {
      const j = glob.indexOf(']', i + 2);
      if (j > 0) {
        let cls = glob.slice(i + 1, j).replace(/\\/g, '\\\\');
        if (cls[0] === '!') cls = '^' + cls.slice(1);
        re += `[${cls}]`; i = j; continue;
      }
    }
    re += escape(c);
  }
  const rx = new RegExp(`^${re}$`, ignoreCase ? 'i' : '');
  cache.set(key, rx);
  return rx;
}

const escape = (c) => c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

export function hasGlob(s) {
  return /(^|[^\\])[*?[{]/.test(s);
}

/** Match a single token (argv element, tool name) against a glob with braces. */
export function matchToken(glob, value, opts) {
  return expandBraces(glob).some((g) => globToRegExp(g, opts).test(value));
}

/** Expand ~ and $HOME / ${HOME} / $PWD in a word. */
export function expandWord(word, { home, cwd }) {
  let w = word;
  if (home) {
    if (w === '~' || w.startsWith('~/')) w = home + w.slice(1);
    w = w.replace(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g, home);
  }
  if (cwd) w = w.replace(/\$\{PWD\}|\$PWD(?![A-Za-z0-9_])/g, cwd);
  return w;
}

export function normalizePath(p) {
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p;
}

/**
 * gitignore-like path matching.
 *  - no slash in pattern ("*.pem", ".env"): matches the name of the file or of any parent directory
 *  - "~/..." or "/...": anchored at home / root
 *  - "**\/x/...": anywhere
 *  - other relative patterns ("config/secrets/**"): anchored at the project directory
 * A pattern also matches everything inside a matching directory.
 */
export function matchPath(pattern, absPath, { home, projectDir }) {
  return expandBraces(pattern).some((p) => matchOnePath(p, absPath, { home, projectDir }));
}

function matchOnePath(pattern, absPath, { home, projectDir }) {
  let p = normalizePath(expandWord(pattern, { home }));
  const target = normalizePath(absPath);
  if (!p.includes('/')) {
    const rx = globToRegExp(p);
    return target.split('/').some((part) => part && rx.test(part));
  }
  if (!p.startsWith('/') && !p.startsWith('**/')) p = path.posix.join(projectDir || '/', p);
  const rx = globToRegExp(p);
  for (let t = target; ; t = path.posix.dirname(t)) {
    if (rx.test(t)) return true;
    if (t === '/' || t === '.' || t === '') return false;
  }
}

export function resolvePath(p, cwd) {
  if (!p) return p;
  return path.posix.resolve(cwd || '/', p);
}
