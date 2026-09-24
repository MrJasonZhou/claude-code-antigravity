---
description: Ask Google Antigravity (agy / Gemini, long context) a read-only question about this codebase or get a second opinion
argument-hint: "[--background] [--model <id|pro|flash>] [--add-dir <dir>] <question>"
allowed-tools: Bash(node:*)
---

Ask agy a read-only question. agy runs Gemini with a very large context window, so it is well suited to whole-codebase questions ("where is X handled", "explain the data flow", "what would break if…") and independent second opinions.

Raw user request:
$ARGUMENTS

Run one Bash call (foreground calls need `timeout: 600000`), never adding `--write` or `--yolo`:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" task "$ARGUMENTS"
```

Return the output verbatim. Do not act on agy's answer unless the user asks you to.
