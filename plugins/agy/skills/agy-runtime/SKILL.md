---
name: agy-runtime
description: Contract for calling the agy companion runtime and presenting agy results back to the user (used by the agy-delegate subagent and /agy commands)
user-invocable: false
---

# agy runtime

Helper: `node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" <subcommand> "<args>"`

| subcommand | purpose |
|---|---|
| `task` | delegate coding work / questions about the workspace |
| `review` | structured code review of working tree, branch (`--base`), one commit (`--commit`), or a GitHub PR (`--pr`); `--adversarial`, focus text |
| `compare` | same read-only question to several models in parallel (`--models gemini,opus,gpt`) |
| `apply [id] [--force]` | apply the patch from a `--worktree` task; if it would conflict, nothing is changed unless `--force` (then conflict markers are written) |
| `transfer` | hand the current Claude session to agy |
| `research` | Google-Search-backed answer with source URLs |
| `image` | generate images, copied to `agy-images/` or `--out` |
| `status [id] [--all]`, `result [id] [--wait]`, `cancel [id]` | background job management (ids are looked up in the current workspace; `--all` searches every workspace) |
| `resume-candidate` | JSON: is there an agy conversation in this workspace to continue? |
| `setup` | check install, sign-in, quota and models (it never installs or signs in); toggle the review gate; manage the command allowlist |

Flags (policy flags apply to `task` and `research`; `review`, `compare`, `transfer` and `image` always run read-only; the `/agy:critique` slash command is a read-only `task` with a fixed instruction, not a separate subcommand):
- Policy: default read-only · `--write` file edits (agy `--mode accept-edits`) · `--worktree` file edits in an isolated git worktree, returned as a patch · `--sandbox` file edits + any shell command in agy's sandbox (agy `--sandbox --dangerously-skip-permissions`; shell sees a read-only filesystem except /tmp, network open; user opt-in, pairs well with `--worktree`) · `--yolo` shell + URLs (agy `--dangerously-skip-permissions`, explicit user opt-in only).
- Commands allowlisted via `setup --allow-command "<cmd>"` are rules in agy's own global settings.json: agy itself enforces them (anything else is denied) in every policy, including your interactive agy sessions. agy is told which ones exist so it can run tests and iterate.
- `--background` detaches and returns a job id. `--model <id|gemini|flash|opus|sonnet|gpt>` (aliases resolve to the newest matching model; with `--effort` they resolve to the base model name, since agy rejects an effort-suffixed id plus a different `--effort`). `--effort low|medium|high|xhigh|max`. `--add-dir <dir>` (repeatable). `--timeout <seconds>`. `--agent <name>` selects a custom agy agent. `--json` prints the raw job record.
- `--models a,b` on `task --worktree`: best-of-N, one independent attempt and patch per model.
- `--prompt-file <path>` appends a file's contents to the prompt; use it for large logs or specs (argv entries are capped at 128 KB).
- `result <id> --wait [--timeout <s>]` blocks until a detached job finishes.
- `--resume-last` continues the last agy conversation in this workspace; `--resume <conversation-id>` continues a specific one.

Why the policies matter: agy's headless mode cannot ask for permission, so a tool outside the policy aborts the run. The output then contains a "stopped because it tried a tool…" note; suggest re-running with `--write`, `--sandbox` or `--yolo` instead of working around it.

Presenting results:
- Output is Markdown; show it verbatim. Keep file paths, line numbers, source URLs, job ids and the follow-up hint.
- Reviews: findings are already sorted by severity. After showing them, stop and ask which to fix. Never auto-apply review fixes.
- Worktree patches: show the stat and ask before running `/agy:apply`.
- Commands: keep the "Commands agy ran" section when present; it is the audit trail of what agy executed.
- Compare: show each model's answer, then synthesize agreements/disagreements.
- Edits: when "Files agy edited" is present, say so, then verify (diff, tests) before calling the work done.
- Failures: show the error block and stop. Do not quietly redo agy's task yourself unless the user asks.
- Setup/auth problems: direct the user to `/agy:setup`.
