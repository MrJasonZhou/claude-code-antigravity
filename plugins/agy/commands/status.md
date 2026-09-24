---
description: Show running and recent agy jobs for this workspace
argument-hint: "[job-id] [--all]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" status "$ARGUMENTS"`

Present the output as-is (a Markdown table when no job id was given). Do not add prose around the table.
