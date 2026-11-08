import { evaluate } from './policy.mjs';

/** Build a PreToolUse payload from a policy test case. */
export function payloadFor(t, cwd) {
  if (t.bash !== undefined) return { tool_name: 'Bash', tool_input: { command: t.bash }, cwd: t.cwd ?? cwd };
  if (t.read !== undefined) return { tool_name: 'Read', tool_input: { file_path: t.read }, cwd: t.cwd ?? cwd };
  if (t.write !== undefined) return { tool_name: 'Write', tool_input: { file_path: t.write, content: '' }, cwd: t.cwd ?? cwd };
  if (t.tool !== undefined) return { tool_name: t.tool, tool_input: t.input ?? {}, cwd: t.cwd ?? cwd };
  throw new Error(`test needs one of bash, read, write, tool: ${JSON.stringify(t)}`);
}

export function describeTest(t) {
  if (t.bash !== undefined) return `bash: ${t.bash}`;
  if (t.read !== undefined) return `read: ${t.read}`;
  if (t.write !== undefined) return `write: ${t.write}`;
  return `tool: ${t.tool}`;
}

/**
 * Run policy tests. `branch` in a test fakes the current git branch.
 * @returns {{passed: number, failures: {test, got, matches}[]}}
 */
export function runTests(policy, tests, { home, cwd, projectDir } = {}) {
  const failures = [];
  let passed = 0;
  for (const t of tests) {
    const payload = payloadFor(t, cwd);
    const res = evaluate(policy, payload, { home, projectDir, branchOf: () => t.branch ?? null });
    if (res.decision === t.expect) passed++;
    else failures.push({ test: t, got: res.decision, matches: res.matches });
  }
  return { passed, failures };
}
