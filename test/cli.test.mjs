import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agentfence.mjs');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentfence-home-'));
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'agentfence-project-'));
const run = (args, input, extraEnv = {}) =>
  spawnSync(process.execPath, [BIN, ...args], {
    input,
    cwd: project,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: project, CLAUDE_PLUGIN_DATA: path.join(home, 'data'), NO_COLOR: '1', ...extraEnv },
  });
const hook = (payload) => run(['hook'], JSON.stringify({ session_id: 's', cwd: project, hook_event_name: 'PreToolUse', ...payload }));

test('hook denies a force push with a Claude Code reply', () => {
  const r = hook({ tool_name: 'Bash', tool_input: { command: 'git push --force origin main' } });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, 'PreToolUse');
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /git-force-push/);
});

test('hook is silent when nothing matches', () => {
  const r = hook({ tool_name: 'Bash', tool_input: { command: 'npm test' } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('hook writes denied and asked actions to the audit log', () => {
  hook({ tool_name: 'Read', tool_input: { file_path: path.join(home, '.ssh', 'id_rsa') } });
  const log = fs.readFileSync(path.join(home, 'data', 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(log.some((e) => e.rules.includes('secrets-keys') && e.decision === 'deny'));
  assert.match(run(['log']).stdout, /secrets-keys/);
});

test('a broken policy file asks instead of silently allowing', () => {
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(project, '.claude', 'agentfence.json'), '{ "rules": [ { "id": "x" ] }');
  const r = hook({ tool_name: 'Bash', tool_input: { command: 'ls' } });
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.permissionDecision, 'ask');
  assert.match(out.permissionDecisionReason, /policy error/);
  fs.rmSync(path.join(project, '.claude'), { recursive: true });
});

test('bad JSON on stdin asks', () => {
  const r = run(['hook'], 'not json');
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'ask');
});

test('init, then test runs the policy tests', () => {
  assert.equal(run(['init']).status, 0);
  assert.equal(run(['init']).status, 1);
  const t = run(['test']);
  assert.equal(t.status, 0, t.stdout);
  assert.match(t.stdout, /2\/2 passed/);
  const f = path.join(project, '.claude', 'agentfence.json');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('"expect": "deny"', '"expect": "none"'));
  const bad = run(['test']);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /expected PASS, got DENY/);
  fs.rmSync(path.join(project, '.claude'), { recursive: true });
});

test('check explains the decision', () => {
  const r = run(['check', '--', 'sudo', 'bash', '-c', 'rm -rf /']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^DENY/);
  assert.match(r.stdout, /via sudo → bash -c/);
  assert.match(r.stdout, /rm-root-or-home/);
  const j = JSON.parse(run(['check', '--json', '--read', '~/.aws/credentials']).stdout);
  assert.equal(j.decision, 'deny');
  assert.match(run(['check', '--branch', 'main', '--', 'git push']).stdout, /^ASK/);
});

test('rules, presets, help and version', () => {
  assert.match(run(['rules']).stdout, /git-force-push/);
  assert.match(run(['presets']).stdout, /database/);
  assert.match(run(['--help']).stdout, /Usage/);
  assert.match(run(['--version']).stdout, /^\d+\.\d+\.\d+/);
  assert.equal(run(['nope']).status, 2);
});
