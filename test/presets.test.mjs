import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPolicy, loadPreset, presetNames } from '../src/policy.mjs';
import { runTests, describeTest } from '../src/testing.mjs';

const env = { home: '/home/user', cwd: '/home/user/project', projectDir: '/home/user/project' };

for (const name of presetNames()) {
  test(`preset ${name}: its own tests pass`, () => {
    const policy = buildPolicy([{ extends: [name] }]);
    const { tests } = loadPreset(name);
    assert.ok(tests.length > 0 || name === 'recommended');
    const r = runTests(policy, tests, env);
    const msg = r.failures.map((f) => `${describeTest(f.test)}: expected ${f.test.expect}, got ${f.got}`).join('\n');
    assert.equal(r.failures.length, 0, msg);
  });
}

test('rule ids are unique across presets', () => {
  const seen = new Map();
  for (const name of presetNames()) {
    if (name === 'recommended') continue;
    for (const r of loadPreset(name).rules) {
      assert.ok(!seen.has(r.id), `${r.id} in ${name} and ${seen.get(r.id)}`);
      seen.set(r.id, name);
    }
  }
});
