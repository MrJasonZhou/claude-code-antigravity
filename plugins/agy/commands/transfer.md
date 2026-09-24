---
description: Hand the current Claude Code session over to agy as a resumable agy conversation
argument-hint: "[--source <claude-session.jsonl>] [--background] [note for agy]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" transfer "$ARGUMENTS"`

Present the output exactly as returned. Keep the agy conversation id, the `agy --conversation <id>` command for continuing interactively in a terminal, and the `/agy:task --resume-last` hint for continuing from Claude Code.
