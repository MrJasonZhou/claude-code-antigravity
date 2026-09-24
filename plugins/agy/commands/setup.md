---
description: Check that the agy CLI is installed and signed in, show quota and models, and optionally toggle the stop-time review gate
argument-hint: "[--enable-review-gate|--disable-review-gate] [--allow-command \"<cmd>\"] [--revoke-command \"<cmd>\"]"
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" setup "$ARGUMENTS"`

Present the output. If agy is not found, tell the user to install the Google Antigravity CLI and re-run `/agy:setup`. If it is not authenticated, tell them to run `! agy` once and complete sign-in. Do not attempt to install or authenticate on their behalf.

When the review gate is enabled: every time Claude is about to stop in this workspace with uncommitted changes, agy reviews any state it has not seen yet and can send Claude back to fix concrete defects. A state agy blocked stays blocked (without another agy call) until the code changes; after 3 consecutive blocks the gate lets the stop through, and it also lets it through if agy fails. It uses agy quota and adds latency to stops with new changes.

`--allow-command` adds a rule to agy's own global settings.json: it applies to every agy session on this machine, including interactive ones. Broad rules (`python3`, `bash`, `git`, …) and shell metacharacters are refused.
