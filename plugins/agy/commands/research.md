---
description: Have agy research a question on the live web with Google Search and return a cited answer
argument-hint: "[--background] [--yolo] [--model <id|pro|flash>] <question>"
allowed-tools: Bash(node:*)
---

agy has built-in Google Search, which makes it good at current facts: latest library versions, API changes, error messages, release notes, standards.

Raw request:
$ARGUMENTS

Run one Bash call (foreground needs `timeout: 600000`):
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" research "$ARGUMENTS"
```
- By default agy can search but not open full pages. Only add `--yolo` (lets it read URLs and run commands) if the user explicitly asks for deeper page reading.

Return the output verbatim, keeping the source URLs. Note in one line if agy flagged low confidence.
