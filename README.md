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
| `/agy:review` | Structured code review. Targets: uncommitted changes, a branch (`--base`), one commit (`--commit <sha>`), or a GitHub PR (`--pr <n>`, uses `gh`). Findings are sorted by severity and include file:line. |
| `/agy:adversarial-review` | Review that challenges the design, its assumptions and how it fails in real use. |
| `/agy:critique <plan or file>` | Adversarial review of a plan, design doc or RFC before any code is written. agy checks each assumption against the actual code. |
| `/agy:compare <question>` | Ask several models the same question in parallel (default `pro,opus,gpt`, i.e. Gemini, Claude and GPT through agy). Claude then summarizes where they agree and disagree. |
| `/agy:apply [id]` | Apply the patch from a `--worktree` task. Falls back to a 3-way merge when needed. |
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
  - `--worktree`: agy edits a throwaway git worktree seeded with your current uncommitted and untracked files. The result comes back as a patch you apply with `/agy:apply`. Your own working tree is never touched, so several agy tasks and Claude can work at the same time.
  - `--yolo`: agy can also run shell commands and fetch URLs (`agy --dangerously-skip-permissions`). Only use this when you ask for it explicitly.
- **Letting agy run tests.** Use `/agy:setup --allow-command "npm test"`. The rule is stored in agy's own `settings.json` and can be removed with `--revoke-command`. agy is told exactly which commands it may run, so it can run the tests and iterate until they pass, without `--yolo`. Rules that are too broad (`python3`, `bash`, `git`, …) and shell metacharacters are refused.
- **Best-of-N.** `/agy:task --worktree --models pro,opus,gpt <task>` has each model implement the task on its own in its own worktree. Claude compares the patches and you apply the one you prefer.
- `--prompt-file <path>` adds a file's contents to the prompt. Use it for large logs, stack traces or specs; a single command-line argument is capped at 128 KB on Linux.
- `/agy:result <id> --wait` blocks until a background job finishes.
- `--background` runs the job in the background. From slash commands, it runs as a Claude background task, so Claude is notified when agy finishes. Follow it with `/agy:status` and `/agy:result`.
- `--resume-last` continues the last completed agy conversation in this workspace. `--resume <conversation-id>` continues a specific one.
- `--model <id|pro|flash|opus|sonnet|gpt>` picks a model. An alias resolves to the newest matching model and prefers the `-high` variant.
- `--effort low|medium|high`, `--add-dir <dir>`, `--timeout <sec>`, `--agent <custom agy agent>`, `--json`.

### What agy is told and what you get back

- **Shared project rules.** agy reads `GEMINI.md` and `AGENTS.md` by itself. The plugin also points it at every `CLAUDE.md` / `CLAUDE.local.md` from the working directory up to the repo root, so both agents follow the same conventions.
- **Images as input.** agy is multimodal. Mention a screenshot, mockup or diagram by its path in any task, for example "implement design/mock.png" or "why is the chart in bug.png empty?".
- **Browser checks.** agy has browser tools. Where Chrome is installed, a `--yolo` task can open your dev server, click through it and take screenshots.
- **Audit trail.** Every result lists the shell commands agy ran, each marked ✓ or ✗. `/agy:status <id>` shows the full timeline of tool calls, including durations and errors.

## How it works

`plugins/agy/scripts/agy-companion.mjs` is a single Node script with no dependencies. It does the following:

1. It builds a prompt with a fixed preamble: the workspace root, the tool policy, and "no human is watching". The prompt goes to agy on **stdin**, so large diffs do not hit argv limits. It runs `agy --output-format stream-json`.
2. It streams events into a job record at `~/.cache/agy-plugin/jobs/` (override with `AGY_PLUGIN_DATA`). The record holds live progress, the files agy edited, denied tools, token usage and the agy conversation id.
3. It renders a Markdown report. Reviews use `--json-schema` with `schemas/review.schema.json` and are rendered as findings sorted by severity. Files agy creates in `~/.gemini/antigravity-cli/brain/<conversation>/` are listed as artifacts, and images are copied into the project.

## Test

```bash
node tests/companion.test.mjs   # uses a fake agy binary; no network or quota
```
