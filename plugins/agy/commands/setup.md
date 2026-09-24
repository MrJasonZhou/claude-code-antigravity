---
description: Check that the agy CLI is installed and signed in, and show quota and available models
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" setup`

Present the output. If agy is not found, tell the user to install the Google Antigravity CLI and re-run `/agy:setup`. If it is not authenticated, tell them to run `! agy` once and complete sign-in. Do not attempt to install or authenticate on their behalf.
