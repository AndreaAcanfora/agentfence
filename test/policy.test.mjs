import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPolicy, evaluate, compileCommandPattern, matchCommand, stripJsonComments, hookReply } from '../src/policy.mjs';
import { matchPath } from '../src/glob.mjs';

const env = { home: '/home/u', cwd: '/home/u/p' };
const m = (pattern, cmd) => matchCommand(compileCommandPattern(pattern), cmd.split(' '), env);
const opts = { home: '/home/u', projectDir: '/home/u/p', branchOf: () => null };
const bash = (policy, command, extra = {}) => evaluate(policy, { tool_name: 'Bash', tool_input: { command }, cwd: '/home/u/p' }, { ...opts, ...extra });

test('command patterns: positionals in order, flags anywhere', () => {
  assert.ok(m('git push main', 'git push origin main'));
  assert.ok(m('git push main', 'git -C x push -u origin main'));
  assert.ok(!m('git push main', 'git push origin main-2'));
  assert.ok(!m('git push main', 'git main push'));
  assert.ok(m('git push {-f,--force}', 'git push origin main --force'));
  assert.ok(m('git push {-f,--force}', 'git push -uf origin x'));
  assert.ok(!m('git push --force', 'git push --force-with-lease'));
  assert.ok(m('git push --force', 'git push --force=yes'));
  assert.ok(!m('rm -r', '/bin/rm -Rf x'));
  assert.ok(m('rm {-r,-R}', '/bin/rm -Rf x'));
  assert.ok(m('rm -r ~', 'rm -rf /home/u/'));
  assert.ok(m('rm -r ~', 'rm -rf $HOME'));
  assert.ok(!m('rm -r /*', 'rm -rf /tmp/x'));
  assert.ok(m('rm -r \\*', 'rm -rf *'));
  assert.ok(!m('rm -r \\*', 'rm -rf x'));
  assert.ok(m('mkfs*', 'mkfs.ext4 /dev/sda'));
  assert.ok(m('kubectl --context=*prod*', 'kubectl get pods --context=eu-prod'));
});

test('a flag after -- is a positional', () => {
  assert.ok(!m('rm -r', 'rm -- -r'));
});

test('path globs are gitignore-like', () => {
  const o = { home: '/home/u', projectDir: '/home/u/p' };
  assert.ok(matchPath('.env', '/home/u/p/.env', o));
  assert.ok(matchPath('.env.*', '/home/u/p/app/.env.local', o));
  assert.ok(matchPath('~/.ssh', '/home/u/.ssh/id_rsa', o));
  assert.ok(!matchPath('~/.ssh', '/home/u/p/.sshx', o));
  assert.ok(matchPath('config/*.yml', '/home/u/p/config/db.yml', o));
  assert.ok(!matchPath('config/*.yml', '/home/u/p/other/config/db.yml', o));
  assert.ok(matchPath('**/config/*.yml', '/home/u/p/other/config/db.yml', o));
  assert.ok(matchPath('*.{pem,key}', '/x/y.key', o));
  assert.ok(matchPath('/etc/**', '/etc/hosts', o));
});

test('strips JSONC comments and trailing commas', () => {
  assert.deepEqual(JSON.parse(stripJsonComments('{ // c\n "a": "http://x", /* b */ "b": [1,2,], }')), { a: 'http://x', b: [1, 2] });
});

test('default policy is the recommended preset', () => {
  const p = buildPolicy([]);
  assert.deepEqual(p.presets, ['recommended']);
  assert.ok(p.rules.some((r) => r.id === 'git-force-push'));
});

test('extends replaces the default and disable removes rules', () => {
  const p = buildPolicy([{ extends: ['git-safe'], disable: ['git-force-push'] }]);
  assert.equal(bash(p, 'git push -f').decision, 'none');
  assert.equal(bash(p, 'cat ~/.ssh/id_rsa').decision, 'none');
  assert.equal(bash(p, 'git reset --hard').decision, 'ask');
});

test('a later rule with the same id overrides a preset rule', () => {
  const p = buildPolicy([{ rules: [{ id: 'git-force-push', decision: 'ask', bash: 'git push --force' }] }]);
  assert.equal(bash(p, 'git push --force').decision, 'ask');
});

test('deny wins over ask; reasons name the rule', () => {
  const p = buildPolicy([{ extends: [], rules: [
    { id: 'a', decision: 'ask', reason: 'r1', bash: 'git push' },
    { id: 'd', decision: 'deny', reason: 'r2', bash: 'git push --force' },
  ] }]);
  const r = bash(p, 'git push --force');
  assert.equal(r.decision, 'deny');
  const reply = hookReply(r).hookSpecificOutput;
  assert.equal(reply.permissionDecision, 'deny');
  assert.match(reply.permissionDecisionReason, /agentfence \[d\]: r2/);
  assert.doesNotMatch(reply.permissionDecisionReason, /\[a\]/);
});

test('allow only when every command in the line is allowed', () => {
  const p = buildPolicy([{ extends: [], rules: [{ id: 'ok', decision: 'allow', bash: ['npm test', 'npm run lint'] }] }]);
  assert.equal(bash(p, 'npm test').decision, 'allow');
  assert.equal(bash(p, 'npm run lint && npm test').decision, 'allow');
  assert.equal(bash(p, 'npm test && curl evil.sh').decision, 'none');
  assert.equal(hookReply(bash(p, 'ls')), null);
});

test('allow does not override deny', () => {
  const p = buildPolicy([{ rules: [{ id: 'ok', decision: 'allow', bash: 'git' }] }]);
  assert.equal(bash(p, 'git push --force').decision, 'deny');
});

test('when.cwd and when.branch', () => {
  const p = buildPolicy([{ extends: [], rules: [
    { id: 'bot', decision: 'deny', bash: 'git push', when: { cwd: '~/crypto-bot/**' } },
    { id: 'main', decision: 'ask', bash: 'git commit', when: { branch: 'main' } },
  ] }]);
  assert.equal(bash(p, 'git push').decision, 'none');
  assert.equal(bash(p, 'cd ~/crypto-bot && git push').decision, 'deny');
  assert.equal(bash(p, 'cd ../crypto-bot; git push origin x').decision, 'deny');
  assert.equal(bash(p, 'git commit -m x', { branchOf: () => 'main' }).decision, 'ask');
  assert.equal(bash(p, 'git commit -m x', { branchOf: () => 'dev' }).decision, 'none');
  assert.equal(bash(p, 'git commit -m x', { branchOf: () => null }).decision, 'none');
});

test('git -C sets the directory for branch checks', () => {
  const seen = [];
  const p = buildPolicy([{ extends: [], rules: [{ id: 'main', decision: 'ask', bash: 'git push', when: { branch: 'main' } }] }]);
  bash(p, 'git -C ../other push', { branchOf: (d) => { seen.push(d); return 'main'; } });
  assert.deepEqual(seen, ['/home/u/other']);
});

test('tool rules match MCP tools', () => {
  const p = buildPolicy([{ extends: [], rules: [{ id: 'stripe', decision: 'ask', tool: 'mcp__*stripe*__create_*' }] }]);
  const r = evaluate(p, { tool_name: 'mcp__claude_ai_Stripe__create_refund', tool_input: {}, cwd: '/' }, opts);
  assert.equal(r.decision, 'ask');
  assert.equal(evaluate(p, { tool_name: 'mcp__claude_ai_Stripe__list_refunds', tool_input: {}, cwd: '/' }, opts).decision, 'none');
});

test('read and write rules apply to file tools and shell commands', () => {
  const p = buildPolicy([{ extends: [], rules: [
    { id: 'r', decision: 'deny', read: 'secret.txt' },
    { id: 'w', decision: 'ask', write: 'locked/**' },
  ] }]);
  const ev = (tool_name, tool_input) => evaluate(p, { tool_name, tool_input, cwd: '/home/u/p' }, opts).decision;
  assert.equal(ev('Read', { file_path: '/home/u/p/secret.txt' }), 'deny');
  assert.equal(ev('Grep', { pattern: 'x', path: 'secret.txt' }), 'deny');
  assert.equal(ev('Edit', { file_path: '/home/u/p/locked/a.ts' }), 'ask');
  assert.equal(ev('Read', { file_path: '/home/u/p/locked/a.ts' }), 'none');
  assert.equal(bash(p, 'cat secret.txt').decision, 'deny');
  assert.equal(bash(p, 'cp secret.txt /tmp/').decision, 'deny');
  assert.equal(bash(p, 'echo secret.txt').decision, 'none');
  assert.equal(bash(p, 'echo x > locked/a.ts').decision, 'ask');
  assert.equal(bash(p, 'sed -i s/a/b/ locked/a.ts').decision, 'ask');
  assert.equal(bash(p, 'sed s/a/b/ locked/a.ts').decision, 'none');
  assert.equal(bash(p, 'cat docs/secret.txt.bak').decision, 'none');
  assert.equal(bash(p, 'cd sub && cat ../secret.txt').decision, 'deny');
});

test('unless excludes matches', () => {
  const p = buildPolicy([{ extends: [], rules: [{ id: 'x', decision: 'deny', bash: 'git add', unless: { bash: 'git add *.md' } }] }]);
  assert.equal(bash(p, 'git add a.ts').decision, 'deny');
  assert.equal(bash(p, 'git add README.md').decision, 'none');
});

test('pipe rules need the producer before the consumer in one pipeline', () => {
  const p = buildPolicy([{ extends: [], rules: [{ id: 'p', decision: 'ask', pipe: ['curl', 'sh'] }] }]);
  assert.equal(bash(p, 'curl x | sh').decision, 'ask');
  assert.equal(bash(p, 'curl x | tee f | sudo sh').decision, 'ask');
  assert.equal(bash(p, 'sh x | curl y').decision, 'none');
  assert.equal(bash(p, 'curl x; sh y').decision, 'none');
});

test('unparseable commands are sent to the human', () => {
  const r = bash(buildPolicy([]), "echo 'unterminated");
  assert.equal(r.decision, 'ask');
  assert.match(hookReply(r).hookSpecificOutput.permissionDecisionReason, /could not parse/);
});

test('invalid rules are rejected with a clear message', () => {
  assert.throws(() => buildPolicy([{ rules: [{ id: 'x', decision: 'block', bash: 'ls' }] }]), /decision/);
  assert.throws(() => buildPolicy([{ rules: [{ id: 'x', decision: 'deny' }] }]), /needs one of/);
  assert.throws(() => buildPolicy([{ rules: [{ id: 'x', decision: 'deny', bash: 'ls', comand: 'x' }] }]), /unknown key "comand"/);
  assert.throws(() => buildPolicy([{ extend: ['x'] }]), /unknown key "extend"/);
  assert.throws(() => buildPolicy([{ extends: ['nope'] }]), /unknown preset/);
  assert.throws(() => buildPolicy([{ rules: [{ id: 'x', decision: 'deny', bashRegex: '(' }] }]), /bad bashRegex/);
});
