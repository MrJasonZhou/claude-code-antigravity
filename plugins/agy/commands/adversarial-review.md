---
description: Run an agy review that challenges the design, assumptions and failure modes of the current change
argument-hint: "[--wait|--background] [--base <ref>|--commit <sha>|--pr <number>] [--scope auto|working-tree|branch] [focus text]"
allowed-tools: Bash(node:*), Bash(git:*), AskUserQuestion
---

Same as `/agy:review`, but add `--adversarial` so agy questions the chosen approach, tradeoffs and real-world failure modes instead of only hunting line-level bugs.

Raw arguments:
`$ARGUMENTS`

Follow the exact execution-mode rules of `/agy:review` (ask wait vs background unless `--wait`/`--background` was given), then run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" review "--adversarial <arguments>"
```

Return the output verbatim. Review-only: do not fix anything; ask the user which findings to act on.
