# agy for Claude Code

A Claude Code plugin that hands work to **Google Antigravity CLI (`agy`)** and brings the results back, in the same way the Codex plugin does. agy runs Gemini (plus the Claude and GPT-OSS models it hosts) and has Google Search, image generation and a very large context window. That makes it a good second agent for Claude.

## Install

```bash
claude plugin marketplace add /path/to/agy_plugin
claude plugin install agy@agy-plugin
```

Requirements: Node ≥ 18, and `agy` on `PATH` (or set `AGY_BIN`). You must have run `agy` once and signed in. Run `/agy:setup` to check everything and see your quota and models.

## Commands

| Command | What it does |
|---|---|
| `/agy:task <task>` | Delegate work: implement, fix, investigate. Offers to continue the previous agy conversation for follow-ups. |
| `/agy:ask <question>` | Read-only questions about the whole codebase, or a second opinion. |
| `/agy:review` | Structured code review of uncommitted changes or a branch (`--base`, `--scope`, focus text). Findings are sorted by severity and include file:line. |
| `/agy:adversarial-review` | Review that challenges the design, its assumptions and how it fails in real use. |
| `/agy:research <question>` | Answer from live Google Search, with source URLs. |
| `/agy:image <description>` | Generate images. Files are saved to `agy-images/`, or to the directory given by `--out`. |
| `/agy:status [id]`, `/agy:result [id]`, `/agy:cancel [id]` | Manage background jobs. |
| `/agy:transfer [note]` | Hand the current Claude Code session to agy. agy reads a condensed transcript, checks the workspace, and replies with goal, progress, open problems and next steps. Continue with `agy --conversation <id>` in a terminal, or `/agy:task --resume-last` from Claude. |
| `/agy:setup [--enable-review-gate\|--disable-review-gate]` | Check install and auth, show quota and models, and turn the stop-time review gate on or off for this workspace. |

### Stop-time review gate

This is off by default. Turn it on per workspace with `/agy:setup --enable-review-gate`. When Claude is about to stop and the working tree has uncommitted changes that agy has not reviewed yet, agy reviews them. If it finds a concrete defect, it blocks the stop and sends Claude back with the findings.

- Each distinct working-tree state is reviewed only once. A stop with no changes, or with the same changes, costs nothing.
- After 3 blocks in a row, the gate lets the stop through, so it cannot loop forever.
- If agy fails (outage, quota, timeout), the stop goes through. A broken gate never traps the session.

Claude can also call the **`agy-delegate`** subagent on its own. It does this for second opinions, whole-codebase questions, current web facts, or tasks that are well bounded.

### Common flags

- **Permission policy.** agy's headless mode cannot ask you for approval. Any tool outside the chosen policy stops the run, and the output tells you so.
  - *(default)* read-only: agy can read files but cannot edit them or run shell commands.
  - `--write`: agy can edit files in the workspace (`agy --mode accept-edits`).
  - `--yolo`: agy can also run shell commands and fetch URLs (`agy --dangerously-skip-permissions`). Only use this when you ask for it explicitly.
- `--background` runs the job detached. Follow it with `/agy:status` and `/agy:result`.
- `--resume-last` continues the last completed agy conversation in this workspace. `--resume <conversation-id>` continues a specific one.
- `--model <id|pro|flash|opus|sonnet|gpt>` picks a model. An alias resolves to the newest matching model and prefers the `-high` variant.
- `--effort low|medium|high`, `--add-dir <dir>`, `--timeout <sec>`, `--agent <custom agy agent>`, `--json`.

## How it works

`plugins/agy/scripts/agy-companion.mjs` is a single Node script with no dependencies. It does the following:

1. It builds a prompt with a fixed preamble: the workspace root, the tool policy, and "no human is watching". The prompt goes to agy on **stdin**, so large diffs do not hit argv limits. It runs `agy --output-format stream-json`.
2. It streams events into a job record at `~/.cache/agy-plugin/jobs/` (override with `AGY_PLUGIN_DATA`). The record holds live progress, the files agy edited, denied tools, token usage and the agy conversation id.
3. It renders a Markdown report. Reviews use `--json-schema` with `schemas/review.schema.json` and are rendered as findings sorted by severity. Files agy creates in `~/.gemini/antigravity-cli/brain/<conversation>/` are listed as artifacts, and images are copied into the project.

## Test

```bash
node tests/companion.test.mjs   # uses a fake agy binary; no network or quota
```
