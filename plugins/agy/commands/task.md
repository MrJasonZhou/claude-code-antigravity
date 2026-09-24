---
description: Delegate a coding task (implementation, fix, investigation) to Google Antigravity (agy)
argument-hint: "[--write|--yolo] [--background|--wait] [--resume|--fresh] [--model <id|pro|flash|opus|sonnet>] [--effort low|medium|high] [--add-dir <dir>] <what agy should do>"
allowed-tools: Bash(node:*), AskUserQuestion
---

Delegate this request to agy through the companion runtime.

Raw user request:
$ARGUMENTS

Permission policy (pass through exactly what the user chose):
- no flag → read-only: agy may read files but not edit or run shell commands. Good for investigation, diagnosis, planning.
- `--write` → agy may create and edit files in the workspace (no shell commands).
- `--yolo` → agy may also run shell commands and fetch URLs. Only pass it when the user explicitly asked for it.
- If the user clearly asks agy to implement/fix/change something but gave no policy flag, add `--write`.

Resume handling:
- If the request includes `--resume`, replace it with `--resume-last`. If it includes `--fresh`, drop it. Do not ask in either case.
- Otherwise run `node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" resume-candidate` first. If it returns `"available": true` AND the request reads like a follow-up ("continue", "keep going", "now also…", "apply the fix"), use `AskUserQuestion` once with the options `Continue current agy conversation (Recommended)` and `Start a new agy conversation`; add `--resume-last` if the user continues. If it is not a follow-up, do not ask.

Execution mode:
- `--background` → keep the flag; the companion detaches and returns a job id immediately.
- `--wait` or no flag → foreground. For large, open-ended or multi-step requests without an explicit flag, prefer adding `--background`.

Run exactly one Bash call (foreground calls need `timeout: 600000`):
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" task "<flags> <task text>"
```
- Keep the user's task text as written. You may prepend a short line of essential context you already know (relevant file paths, the error message) — do not investigate the repo to build it.

After it returns:
- Present the companion output to the user verbatim (it is already Markdown).
- If agy edited files, say so and list them; then verify the change yourself (read the diff, run the verification commands it suggested) before claiming success.
- If agy failed or was blocked by the permission policy, report that and stop; do not silently redo the task yourself.
- If `agy` is missing or unauthenticated, tell the user to run `/agy:setup`.
