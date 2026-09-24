---
description: Show the stored output of a finished agy job (latest one by default)
argument-hint: "[job-id]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" result "$ARGUMENTS"`

Present the full output to the user without summarizing: keep verdicts, findings, file paths and line numbers, edited files, artifacts and follow-up hints exactly as reported. If it is a review, do not fix anything until the user says which findings to address.
