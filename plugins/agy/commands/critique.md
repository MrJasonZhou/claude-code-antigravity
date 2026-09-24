---
description: Have agy critically review a plan, design doc or proposal against this codebase before any code is written
argument-hint: "[--model <id|pro|opus>] [--background] <plan text | path to plan/design file>"
allowed-tools: Bash(node:*), Write
---

Get an independent, adversarial review of a plan *before* implementing it. agy reads the relevant code (with its large context), so it can check the plan against how the codebase actually works.

Raw request:
$ARGUMENTS

Build the input:
- If the request names an existing file (a plan, design doc, RFC, ADR), pass it with `--prompt-file <path>`.
- If the request refers to the plan you (Claude) just proposed in this conversation, write that plan verbatim to a file in the scratchpad and pass it with `--prompt-file`.
- Otherwise use the request text itself.

Run one Bash call (with `timeout: 600000`, or `run_in_background: true` if the user passed `--background`, which you strip). Keep the instruction text below exactly:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" task "[--model ...] [--prompt-file <path>] Critically review the following plan against the actual code in this workspace before anyone implements it. Verify its assumptions by reading the relevant files. Report: (1) wrong or unverified assumptions about the code, with file:line evidence; (2) missing steps, edge cases, migrations, and failure modes; (3) simpler or safer alternatives; (4) risks ranked by severity; (5) a verdict — proceed, proceed with changes, or rethink. Do not write code. PLAN: <plan text if not using --prompt-file>"
```

Present agy's critique verbatim. Then say briefly which points you agree with and which you doubt, and ask the user whether to revise the plan. Do not start implementing.
