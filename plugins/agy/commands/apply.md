---
description: Apply the patch produced by an agy --worktree task to the current working tree
argument-hint: "[job-id]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" apply "$ARGUMENTS"`

Present the output as-is. If the patch applied, offer to review the resulting diff or run the project's tests. If it failed with conflicts, show the error and ask the user how to proceed; do not hand-merge unprompted.
