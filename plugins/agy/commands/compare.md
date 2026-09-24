---
description: Ask several models through agy (Gemini, Claude, GPT) the same question in parallel and compare their answers
argument-hint: "[--models pro,opus,gpt] [--background] <question>"
allowed-tools: Bash(node:*)
---

agy hosts models from several vendors. Asking them the same question gives independent perspectives, which is useful for design decisions, tricky bugs, and "is this approach sound?" questions. All runs are read-only.

Raw request:
$ARGUMENTS

If the request includes `--background`, strip it and run the command with `Bash(..., run_in_background: true)` (you are notified with the output when all models finish). Otherwise run one foreground Bash call with `timeout: 600000`:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" compare "<arguments>"
```
- Default models are `pro,opus,gpt` (aliases resolve to the newest matching model). Pass through a user-supplied `--models` list unchanged.

Then:
1. Show each model's answer (you may trim repetition, but keep every concrete claim and file:line reference).
2. Add a short **Synthesis**: where they agree, where they disagree, and which position the evidence supports. Mark claims you have not verified yourself.
