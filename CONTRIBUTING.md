# Contributing

Thanks for helping! The most useful contributions are:

1. **A command that slips through** a rule it should hit (or a false alarm). Open an issue with the exact command,
   what agentfence decided (`agentfence check -- '<command>'`) and what you expected.
2. **New rules or presets.** Every rule needs tests in the same preset file: at least one command it must catch and
   one similar command it must leave alone.
3. **Parser fixes** in `src/shell.mjs`, with a test in `test/shell.test.mjs`.

## Setup

```sh
git clone https://github.com/AndreaAcanfora/agentfence && cd agentfence
npm test                                 # no install step: zero dependencies
node bin/agentfence.mjs test --presets
claude --plugin-dir .                    # try it in Claude Code
```

## Guidelines

- No runtime dependencies. The hook runs on every tool call and must stay fast and auditable.
- Prefer `ask` over `deny` unless the action is almost never what the user wants.
- Rule `reason`s are read by the model: say what is dangerous and, when possible, what to do instead.
- Keep `node --test` green on Node 18+.
