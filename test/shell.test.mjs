import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, ParseError } from '../src/shell.mjs';

const argvs = (s) => parse(s).commands.map((c) => c.argv);
const has = (s, argv) => assert.ok(argvs(s).some((a) => JSON.stringify(a) === JSON.stringify(argv)), `${s} -> ${JSON.stringify(argvs(s))}`);

test('splits on operators', () => {
  assert.deepEqual(argvs('a 1 && b 2 || c; d | e & f'), [['a', '1'], ['b', '2'], ['c'], ['d'], ['e'], ['f']]);
});

test('quotes and escapes are removed like a shell would', () => {
  assert.deepEqual(argvs(`r''m -r\\f "a b" 'c d' $'e\\tf'`), [['rm', '-rf', 'a b', 'c d', 'e\tf']]);
  assert.deepEqual(argvs('\\rm x'), [['rm', 'x']]);
  assert.deepEqual(argvs('echo "say \\"hi\\""'), [['echo', 'say "hi"']]);
});

test('comments and line continuations', () => {
  assert.deepEqual(argvs('ls # rm -rf /'), [['ls']]);
  assert.deepEqual(argvs('git \\\n push'), [['git', 'push']]);
  assert.deepEqual(argvs('echo a#b'), [['echo', 'a#b']]);
});

test('assignments and keywords are stripped', () => {
  assert.deepEqual(argvs('FOO=1 BAR="x y" npm test'), [['npm', 'test']]);
  assert.deepEqual(argvs('if true; then rm x; fi'), [['true'], ['rm', 'x']]);
  assert.deepEqual(argvs('for f in *; do rm "$f"; done'), [['rm', '$f']]);
  assert.deepEqual(argvs('{ ls; }'), [['ls']]);
});

test('pipelines carry stage numbers', () => {
  const cs = parse('curl x | sudo bash').commands;
  assert.equal(cs[0].stage, 0);
  assert.equal(cs[1].stage, 1);
  assert.equal(cs[1].pipeline, cs[0].pipeline);
  assert.deepEqual(cs[2].argv, ['bash']);
  assert.equal(cs[2].stage, 1);
});

test('redirections are captured, not passed as args', () => {
  const [c] = parse('echo hi > out.txt 2>&1 < in.txt').commands;
  assert.deepEqual(c.argv, ['echo', 'hi']);
  assert.deepEqual(c.redirects.map((r) => [r.op, r.target]), [['>', 'out.txt'], ['>&', '1'], ['<', 'in.txt']]);
  assert.deepEqual(parse('cmd 2>/dev/null').commands[0].redirects[0], { op: '>', fd: '2', target: '/dev/null', body: undefined });
});

test('command substitution is parsed', () => {
  has('echo $(rm -rf /)', ['rm', '-rf', '/']);
  has('echo "$(git push -f)"', ['git', 'push', '-f']);
  has('echo `whoami`', ['whoami']);
  has('diff <(cat a) <(cat b)', ['cat', 'a']);
  assert.deepEqual(argvs('echo $((1 + 2))'), [['echo', '$((1 + 2))']]);
});

test('wrappers are unwrapped', () => {
  has('sudo -u root rm -rf /', ['rm', '-rf', '/']);
  has('env -i FOO=1 rm x', ['rm', 'x']);
  has('env -S "rm -rf x"', ['rm', '-rf', 'x']);
  has('nohup nice -n 10 timeout -s KILL 5 rm x', ['rm', 'x']);
  has('xargs -0 -n 1 rm -f', ['rm', '-f']);
  has('command rm x', ['rm', 'x']);
  has('exec rm x', ['rm', 'x']);
  has('npx -y prisma migrate reset', ['prisma', 'migrate', 'reset']);
  has('bundle exec rake db:drop', ['rake', 'db:drop']);
  has('uv run --with rich python x.py', ['python', 'x.py']);
});

test('shells, eval, ssh and find -exec are parsed recursively', () => {
  has('bash -c "git push --force"', ['git', 'push', '--force']);
  has('sh -ec \'rm -rf /\'', ['rm', '-rf', '/']);
  has("zsh -lc 'sudo rm x'", ['rm', 'x']);
  has("eval 'git reset --hard'", ['git', 'reset', '--hard']);
  has('ssh -p 22 host "rm -rf /var"', ['rm', '-rf', '/var']);
  has('find . -name x -exec rm -rf {} \;', ['rm', '-rf', '{}']);
  has('watch -n 1 "rm x"', ['rm', 'x']);
  has('bash <<< "rm x"', ['rm', 'x']);
});

test('heredocs fed to a shell are parsed, others are data', () => {
  has('bash <<EOF\nrm -rf /\nEOF', ['rm', '-rf', '/']);
  has("sh <<-'X'\n\trm y\n\tX\necho after", ['rm', 'y']);
  has('bash <<EOF\nrm -rf /\nEOF\necho after', ['echo', 'after']);
  assert.ok(!argvs('cat <<EOF\nrm -rf /\nEOF').some((a) => a[0] === 'rm'));
});

test('bash -c with nested quotes', () => {
  has(`bash -c "sh -c 'git push -f'"`, ['git', 'push', '-f']);
});

test('records the wrapper chain', () => {
  const c = parse('sudo bash -c "rm x"').commands.find((c) => c.argv[0] === 'rm');
  assert.deepEqual(c.via, ['sudo', 'bash -c']);
});

test('unterminated input is a parse error', () => {
  assert.throws(() => parse("echo 'oops"), ParseError);
  assert.throws(() => parse('echo "oops'), ParseError);
  assert.throws(() => parse('echo $(oops'), ParseError);
});

test('nesting depth is limited', () => {
  let s = 'ls';
  for (let i = 0; i < 12; i++) s = `eval ${JSON.stringify(s)}`;
  assert.throws(() => parse(s), ParseError);
});
