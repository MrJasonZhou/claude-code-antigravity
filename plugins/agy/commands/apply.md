---
description: Apply the patch produced by an agy --worktree task to the current working tree
argument-hint: "[job-id] [--force]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" apply "$ARGUMENTS"`

Present the output as-is. If the patch applied, offer to review the resulting diff or run the project's tests. If it reports that the patch would conflict, nothing was changed: show the conflicting files and ask whether to re-run with `--force` (writes conflict markers), have agy redo the task on the current state, or drop it. Do not hand-merge unprompted.
