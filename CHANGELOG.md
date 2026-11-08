# Changelog

## 0.1.0 (2026-11-08)

First release.

- `PreToolUse` hook for Claude Code, packaged as a plugin and a plugin marketplace.
- Shell parser: quotes, escapes, operators, pipelines, redirections, heredocs, command and process substitution,
  and wrappers (`sudo`, `env`, `xargs`, `timeout`, `nice`, `bash -c`, `eval`, `ssh`, `find -exec`, `watch`, `npx`, `uv run`, ...).
- Rules: `bash` patterns, `bashRegex`, `read` / `write` path globs (also for shell commands), `tool`, `pipe`, `unless`, `when` (cwd, git branch).
- Presets: `recommended` (`destructive`, `git-safe`, `secrets`, `remote-exec`, `evasion`), `cloud`, `database`, `publish`, with 117 tests.
- Policy tests in policy files, run with `agentfence test`.
- CLI: `check`, `test`, `init`, `rules`, `presets`, `log`; audit log of denied and asked calls.
- JSON schema for policy files.
