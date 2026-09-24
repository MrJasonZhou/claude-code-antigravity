---
description: Generate images (icons, illustrations, UI mockups) with agy's image model and save them into the project
argument-hint: "[--out <dir>] [--background] <image description>"
allowed-tools: Bash(node:*), Read
---

Generate images with agy's `generate_image` tool. Generated files are copied into `<project>/agy-images/` (or `--out <dir>`).

Raw request:
$ARGUMENTS

If the request includes `--background`, strip it and run the command with `Bash(..., run_in_background: true)` (you are notified with the output when agy finishes; tell the user `/agy:status` shows progress). Otherwise run one foreground Bash call with `timeout: 600000`:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" image "$ARGUMENTS"
```

Return the output verbatim. Then use `Read` on each saved image path so the user can see it, and briefly say whether it matches the request.
