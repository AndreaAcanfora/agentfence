---
name: agentfence
description: Use when a tool call was blocked or flagged by agentfence ("agentfence [rule-id]: ..."), or when the user wants to see, change or test their agentfence policy (rules that block force pushes, rm -rf, secret reads, curl | sh and similar).
---

# agentfence

agentfence is a PreToolUse hook that checks every tool call against a policy before it runs.
A denied call shows up as `agentfence [rule-id]: reason (matched: ...)`.

## When a call is denied

- Do not try to get around the rule: no rewording of the command, no other tool, no
  encoding, no script file that does the same thing. The policy is the user's decision.
- Tell the user, in one or two sentences, what you tried to do and which rule stopped it.
- If the action is really needed, suggest a safer way (for example `--force-with-lease`
  on a feature branch) or offer to change the policy, and wait for their answer.

## The CLI

The CLI is in this plugin: `node "${CLAUDE_PLUGIN_ROOT}/bin/agentfence.mjs" <command>`.

- `check -- <command>`: what the policy decides for a shell command, and how it was parsed
- `check --read <path>` / `--write <path>` / `--tool <name>`
- `rules`: rules in effect in this project
- `test`: run the `tests` in the policy files. Run it after every policy change
- `init`: create `.claude/agentfence.json`
- `log`: recent denied and asked actions

## Policy files

Merged in this order: `~/.claude/agentfence.json`, `<project>/.claude/agentfence.json`,
`<project>/.claude/agentfence.local.json`. JSON with comments.

```jsonc
{
  "extends": ["recommended", "cloud"],     // presets; default is ["recommended"]
  "disable": ["git-push-protected-branch"], // turn off rules by id
  "rules": [
    {
      "id": "no-prod-deploy",
      "decision": "deny",                   // deny | ask | allow
      "reason": "Production deploys go through CI",
      "bash": "npm run deploy:prod",         // command pattern(s)
      "when": { "cwd": "~/work/**" }        // optional: cwd and/or git branch globs
    }
  ],
  "tests": [
    { "bash": "npm run deploy:prod", "expect": "deny" },
    { "bash": "npm run build", "expect": "none" }
  ]
}
```

Matchers: `bash` (command patterns), `bashRegex` (case-insensitive regex on each command),
`read` / `write` (gitignore-like path globs, also applied to `cat`, `cp`, `>` and friends),
`tool` (tool name globs, e.g. `mcp__stripe__*`), `pipe` (`["curl", "sh"]`), plus `unless`.

Command pattern rules: the first word is the command; other words must appear in order;
flags (`-f`, `{--force,-f}`) may appear anywhere and `-r` also matches `-rf`;
globs: `*` (no `/`), `**`, `?`, `{a,b}`; `\*` is a literal star.

When you change the policy, add a test for the new rule and run `test`.
