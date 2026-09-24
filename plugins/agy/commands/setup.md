---
description: Check that the agy CLI is installed and signed in, show quota and models, and optionally toggle the stop-time review gate
argument-hint: "[--enable-review-gate|--disable-review-gate] [--allow-command \"<cmd>\"] [--revoke-command \"<cmd>\"]"
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" setup "$ARGUMENTS"`

Present the output. If agy is not found, tell the user to install the Google Antigravity CLI and re-run `/agy:setup`. If it is not authenticated, tell them to run `! agy` once and complete sign-in. Do not attempt to install or authenticate on their behalf.

When the review gate is enabled: every time Claude is about to stop in this workspace with uncommitted changes that agy has not yet seen, agy reviews them and can send Claude back to fix concrete defects. It uses agy quota, adds latency to each stop, gives up after 3 consecutive blocks, and lets the stop through if agy fails.
