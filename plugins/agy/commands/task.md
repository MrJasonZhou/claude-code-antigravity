---
description: Delegate a coding task (implementation, fix, investigation) to Google Antigravity (agy)
argument-hint: "[--write|--worktree|--yolo] [--models a,b] [--background|--wait] [--resume|--fresh] [--model <id|pro|flash|opus|sonnet>] [--effort low|medium|high] [--add-dir <dir>] <what agy should do>"
allowed-tools: Bash(node:*), AskUserQuestion
---

Delegate this request to agy through the companion runtime.

Raw user request:
$ARGUMENTS

Permission policy (pass through exactly what the user chose):
- no flag → read-only: agy may read files but not edit or run shell commands. Good for investigation, diagnosis, planning.
- `--write` → agy may create and edit files in the workspace (no shell commands).
- `--worktree` → agy edits an isolated git worktree seeded with the current uncommitted state; the result is a patch the user applies with `/agy:apply`. Prefer it when Claude is also editing, for parallel attempts, or for risky changes.
- `--yolo` → agy may also run arbitrary shell commands and fetch URLs. Only pass it when the user explicitly asked for it.
- `--worktree --models pro,opus` → best-of-N: each model implements the task independently in its own worktree. Present the attempts side by side (approach, diff size, risks), recommend one, and let the user pick which to `/agy:apply`.
- Commands allowlisted with `/agy:setup --allow-command "<cmd>"` (e.g. the test command) are usable in every mode, so agy can run tests and iterate.
- If the user clearly asks agy to implement/fix/change something but gave no policy flag, add `--write`.

Resume handling:
- If the request includes `--resume`, replace it with `--resume-last`. If it includes `--fresh`, drop it. Do not ask in either case.
- Otherwise run `node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" resume-candidate` first. If it returns `"available": true` AND the request reads like a follow-up ("continue", "keep going", "now also…", "apply the fix"), use `AskUserQuestion` once with the options `Continue current agy conversation (Recommended)` and `Start a new agy conversation`; add `--resume-last` if the user continues. If it is not a follow-up, do not ask.

Execution mode:
- `--background` → strip it and run the same command with `Bash(..., run_in_background: true)`. Claude Code notifies you with agy's full output when it finishes; meanwhile tell the user agy is working and that `/agy:status` shows live progress. Do not poll.
- `--wait` → strip it and run in the foreground (`timeout: 600000`).
- Neither → foreground for small, bounded requests; background for large, open-ended or multi-step ones.

Run exactly one Bash call (foreground calls need `timeout: 600000`):
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" task "<flags> <task text>"
```
- Large context (logs, stack traces, specs over a few KB): write it to a file in the scratchpad and pass `--prompt-file <path>` instead of inlining it.
- Images: agy is multimodal. Reference screenshots, mockups or diagrams by path in the task text (e.g. "implement the layout in design/mock.png", "why does screenshot.png show a blank chart?"); it can view them in any mode.
- Keep the user's task text as written. You may prepend a short line of essential context you already know (relevant file paths, the error message) — do not investigate the repo to build it.

After it returns:
- Present the companion output to the user verbatim (it is already Markdown).
- If agy produced a worktree patch, show the stat and ask whether to `/agy:apply` it — do not apply it yourself unprompted.
- If agy edited files, say so and list them; then verify the change yourself (read the diff, run the verification commands it suggested) before claiming success.
- If agy failed or was blocked by the permission policy, report that and stop; do not silently redo the task yourself.
- If `agy` is missing or unauthenticated, tell the user to run `/agy:setup`.
