---
description: Generate images (icons, illustrations, UI mockups) with agy's image model and save them into the project
argument-hint: "[--out <dir>] [--background] <image description>"
allowed-tools: Bash(node:*), Read
---

Generate images with agy's `generate_image` tool. Generated files are copied into `<project>/agy-images/` (or `--out <dir>`).

Raw request:
$ARGUMENTS

Run one Bash call (foreground needs `timeout: 600000`):
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" image "$ARGUMENTS"
```

Return the output verbatim. Then use `Read` on each saved image path so the user can see it, and briefly say whether it matches the request.
