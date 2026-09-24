---
description: Run an agy (Gemini) code review of uncommitted changes or the current branch
argument-hint: "[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--model <id|pro|flash>] [focus text]"
allowed-tools: Bash(node:*), Bash(git:*), AskUserQuestion
---

Run an agy code review through the companion runtime. The companion collects the diff itself and asks agy for structured findings.

Raw arguments:
`$ARGUMENTS`

Core constraint: this command is review-only. Do not fix anything, apply patches, or say you are about to.

Execution mode:
- If the arguments include `--wait` or `--background`, do not ask.
- Otherwise size the change: `git status --short --untracked-files=all` and `git diff --shortstat HEAD` (or `git diff --shortstat <base>...HEAD` when `--base` is given). If it is tiny (about 1-2 files), recommend waiting; otherwise recommend background. Ask once with `AskUserQuestion`: `Wait for results` / `Run in background`, recommended option first with ` (Recommended)`. If the user picks background, add `--background`.

Run (foreground needs `timeout: 600000`):
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" review "<arguments>"
```

Return the output verbatim. Then STOP and ask the user which findings, if any, they want fixed. Never auto-apply fixes from a review.
