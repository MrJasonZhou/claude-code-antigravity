#!/usr/bin/env node
// agy-companion: bridge between Claude Code and the Google Antigravity CLI (`agy`).
// Subcommands: setup | task | review | research | image | compare | transfer | apply | status | result | cancel | resume-candidate
// No dependencies beyond Node >= 18.

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = path.resolve(path.dirname(SELF), "..");
// Not CLAUDE_PLUGIN_DATA: other plugins' values leak into the shared Bash environment.
const DATA_DIR = process.env.AGY_PLUGIN_DATA || path.join(os.homedir(), ".cache", "agy-plugin");
const JOBS_DIR = path.join(DATA_DIR, "jobs");
const AGY_BRAIN = path.join(os.homedir(), ".gemini", "antigravity-cli", "brain");
const AGY_SETTINGS = path.join(os.homedir(), ".gemini", "antigravity-cli", "settings.json");
const MAX_JOBS = 200;
const REVIEW_SCHEMA = path.join(PLUGIN_ROOT, "schemas", "review.schema.json");
const MAX_DIFF_BYTES = 600_000; // Gemini has a long context; beyond this agy reads files itself.
const EDIT_TOOLS = new Set(["write_to_file", "replace_file_content", "multi_replace_file_content", "sed_file", "notebook_edit"]);
const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;

// ---------- args ----------

export function tokenize(str) {
  const out = [];
  let cur = "", quote = null, has = false;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < str.length) cur += str[++i];
      else cur += c;
    } else if ((c === '"' || c === "'") && !has && str.indexOf(c, i + 1) > i) { quote = c; has = true; }
    else if (/\s/.test(c)) { if (has || cur) out.push(cur); cur = ""; has = false; }
    else if (c === "\\" && i + 1 < str.length) { cur += str[++i]; has = true; }
    else { cur += c; has = true; }
  }
  if (has || cur) out.push(cur);
  return out;
}

const BOOL = new Set(["write", "yolo", "background", "wait", "json", "resume-last", "fresh", "adversarial", "all", "keep", "enable-review-gate", "disable-review-gate", "worktree"]);
const VALUE = new Set(["model", "effort", "resume", "add-dir", "timeout", "base", "scope", "out", "agent", "source", "commit", "pr", "models", "allow-command", "revoke-command", "prompt-file"]);

export function parseArgs(tokens) {
  const opts = { "add-dir": [] }, rest = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--") { rest.push(...tokens.slice(i + 1)); break; }
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(t);
    if (m && BOOL.has(m[1])) { opts[m[1]] = true; continue; }
    if (m && VALUE.has(m[1])) {
      const v = m[2] ?? tokens[++i];
      if (v === undefined) throw new Error(`--${m[1]} needs a value`);
      if (m[1] === "add-dir") opts["add-dir"].push(v); else opts[m[1]] = v;
      continue;
    }
    rest.push(t);
  }
  opts.text = rest.join(" ").trim();
  return opts;
}

// ---------- agy binary ----------

function findAgy() {
  if (process.env.AGY_BIN) return process.env.AGY_BIN;
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    const p = path.join(dir, "agy");
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  const fallback = path.join(os.homedir(), ".local", "bin", "agy");
  return fs.existsSync(fallback) ? fallback : null;
}

function agySync(args, input) {
  const bin = findAgy();
  if (!bin) return { ok: false, stdout: "", stderr: "agy not found" };
  const r = spawnSync(bin, args, { input, encoding: "utf8", timeout: 120_000 });
  return { ok: r.status === 0, stdout: r.stdout || "", stderr: r.stderr || String(r.error || "") };
}

function listModels() {
  // `agy models` prints "<id>\t<display name>" per line.
  return agySync(["models"]).stdout.split("\n").filter((l) => l.includes("\t"))
    .map((l) => { const [id, name] = l.split("\t"); return { id: id.trim(), name: name.trim() }; });
}

// `pro`, `flash`, `opus`, `sonnet`, `claude`, `gpt` -> newest matching model id (prefers -high variants).
export function resolveModel(value, models) {
  if (!value) return null;
  if (models.some((m) => m.id === value)) return value;
  const hits = models.filter((m) => m.id.includes(value.toLowerCase()));
  if (!hits.length) return value;
  return (hits.find((m) => /high|thinking/.test(m.id)) || hits[0]).id;
}

// ---------- jobs ----------

const jobFile = (id) => path.join(JOBS_DIR, `${id}.json`);
const logFile = (id) => path.join(JOBS_DIR, `${id}.log`);

function saveJob(job) {
  fs.mkdirSync(JOBS_DIR, { recursive: true });
  const tmp = `${jobFile(job.id)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(job, null, 2));
  fs.renameSync(tmp, jobFile(job.id));
}

function loadJob(id) {
  try { return JSON.parse(fs.readFileSync(jobFile(id), "utf8")); } catch { return null; }
}

function listJobs(cwd, all) {
  let files = [];
  try { files = fs.readdirSync(JOBS_DIR).filter((f) => f.endsWith(".json")); } catch {}
  return files.map((f) => loadJob(f.slice(0, -5))).filter((j) => j && (all || j.cwd === cwd))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// A job whose worker died without writing a result is failed, not "running" forever.
function refresh(job) {
  if (job.status === "running" && job.pid && !isAlive(job.pid)) {
    job.status = "failed";
    job.error = job.error || "worker process exited unexpectedly";
    saveJob(job);
  }
  return job;
}

function findJob(ref, cwd) {
  if (ref) {
    const j = loadJob(ref) || listJobs(cwd, true).find((x) => x.id.startsWith(ref));
    return j && refresh(j);
  }
  return null;
}

// ---------- prompts ----------

const POLICY = {
  read: "TOOL POLICY: READ-ONLY. Do not create or modify files. Use file viewing/search tools only. URL fetching (read_url_content) is NOT permitted and any attempt aborts the whole run.",
  write: "TOOL POLICY: you MAY create and edit files inside the workspace using file-editing tools. URL fetching (read_url_content) is NOT permitted and any attempt aborts the whole run.",
  yolo: "TOOL POLICY: full access, including shell commands and URL fetching. Stay inside the workspace. Never run destructive commands (rm -rf, git reset --hard, git push --force, dropping data) and do not commit or push.",
};

// ---------- agy command allowlist (persistent, in agy's own settings.json) ----------

function readAgySettings() {
  try { return JSON.parse(fs.readFileSync(AGY_SETTINGS, "utf8")); } catch { return {}; }
}

export function allowedCommands(settings = readAgySettings()) {
  return (settings.permissions?.allow || []).map((r) => /^command\((.+)\)$/.exec(r)?.[1]).filter((c) => c && c !== "*");
}

// A rule like command(python3) would let agy run arbitrary code; require a specific subcommand.
const TOO_BROAD = /^(\*|sh|bash|zsh|fish|env|sudo|su|rm|python3?|node|deno|bun|perl|ruby|php|curl|wget|git|npx|pnpx|bunx|eval|exec|xargs|find|docker|kubectl)$/;

export function validateAllowCommand(cmd) {
  const c = String(cmd || "").trim().replace(/\s+/g, " ");
  if (!c) throw new Error("empty command");
  if (/[;&|`$<>(){}\\\n]/.test(c)) throw new Error(`"${c}": shell metacharacters are not allowed in an allow rule`);
  if (TOO_BROAD.test(c)) throw new Error(`"${c}" is too broad; allow a specific command such as "npm test" or "pytest"`);
  return c;
}

function updateAllowlist(cmd, add) {
  const settings = readAgySettings();
  const rule = `command(${cmd})`;
  const allow = (settings.permissions?.allow || []).filter((r) => r !== rule);
  if (add) allow.push(rule);
  settings.permissions = { ...settings.permissions, allow };
  fs.mkdirSync(path.dirname(AGY_SETTINGS), { recursive: true });
  fs.writeFileSync(AGY_SETTINGS, `${JSON.stringify(settings, null, 2)}\n`);
}

function policyText(policy) {
  if (policy === "yolo") return POLICY.yolo;
  const cmds = allowedCommands();
  const shell = cmds.length
    ? `Shell commands (run_command) are permitted ONLY when the whole command starts with one of these allowlisted prefixes: ${cmds.map((c) => `\`${c}\``).join(", ")}. Run them from the workspace root and do not chain other commands with && ; or |. ${policy === "write" ? "Use them to verify your change and iterate until they pass." : "Use them only for diagnosis."} Any other shell command aborts the whole run.`
    : `Shell commands (run_command) are NOT permitted and any attempt aborts the whole run.${policy === "write" ? " Do not try to run tests or builds; list the exact commands Claude should run to verify your change." : ""}`;
  return `${POLICY[policy]} ${shell}`;
}

// agy reads GEMINI.md/AGENTS.md natively but not Claude's CLAUDE.md; point it at them so both agents follow one rulebook.
function projectRules(cwd) {
  const found = [];
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    for (const f of ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"]) if (fs.existsSync(path.join(dir, f))) found.push(path.join(dir, f));
    if (fs.existsSync(path.join(dir, ".git")) || path.dirname(dir) === dir) break;
  }
  return found.length ? `PROJECT RULES: read ${found.join(", ")} before starting and follow those conventions (they are the project's rules for coding agents).` : "";
}

function preamble(cwd, policy, extraDirs) {
  return [
    "You are running headlessly as a delegated worker for Claude Code (another AI coding agent). No human is watching: never ask questions; make reasonable assumptions and state them in your answer.",
    `WORKSPACE ROOT (absolute): ${cwd}`,
    extraDirs.length ? `ADDITIONAL DIRECTORIES: ${extraDirs.join(", ")}` : "",
    "Resolve every relative path against the workspace root. Do not browse outside it unless the task requires it, and never read shell history, environment variables, credentials or dotfiles in the home directory.",
    projectRules(cwd),
    policyText(policy),
  ].filter(Boolean).join("\n");
}

const TASK_TAIL = `When finished, end with a concise report using these headings:
## Result
## Files changed (absolute paths; "none" if none)
## Verification (commands Claude should run, or what you checked)
## Risks / open questions`;

const ASK_TAIL = `Answer directly and concisely. Back every claim about the code with file:line references. Separate what you verified in the code from what you infer.`;

const RESEARCH_TAIL = `This is a research task. Use the search_web tool (Google Search) for anything that may have changed recently; prefer primary sources (official docs, changelogs, source repos, standards).
Answer with these headings:
## Answer (direct, 1-5 sentences)
## Key findings (bullets, each with its source URL)
## Confidence & caveats (what is uncertain, dated, or conflicting)`;

function reviewInstructions(adversarial, focus) {
  const base = adversarial
    ? `You are performing an ADVERSARIAL design review. Challenge the approach itself: question assumptions, tradeoffs, failure modes under real-world load/concurrency/bad input, security and data-loss risks, and whether a simpler or safer design exists. Do not nitpick style.`
    : `You are performing a rigorous code review of the change below. Report only real problems: bugs, regressions, security issues, data loss, race conditions, broken edge cases, missing error handling at trust boundaries, and meaningful test gaps. No style nitpicks.`;
  return `${base}
You may open any workspace file to understand context beyond the diff. Every finding must point at a concrete file and line in the NEW code, explain the failure scenario, and give a fix. If nothing is wrong, return verdict "approve" with an empty findings list.
${focus ? `\nUSER FOCUS: ${focus}\n` : ""}
Return ONLY a JSON object matching the provided schema.`;
}

// ---------- git context for reviews ----------

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || "").trim()}`);
  return r.stdout;
}

function defaultBase(cwd) {
  try { return git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).trim(); } catch {}
  for (const b of ["main", "master", "origin/main", "origin/master"]) {
    try { git(cwd, ["rev-parse", "--verify", "--quiet", b]); return b; } catch {}
  }
  return null;
}

export function collectReviewContext(cwd, { base, scope = "auto", commit, pr }) {
  if (pr) return prContext(cwd, pr);
  git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (commit) {
    const body = git(cwd, ["show", "--no-color", "--format=commit %H%nAuthor: %an%nDate: %ad%n%n%B", commit]);
    return finishContext({ label: `commit ${commit}`, scope: "commit", body, stat: git(cwd, ["show", "--stat", "--format=", commit]) });
  }
  const hasHead = (() => { try { git(cwd, ["rev-parse", "--verify", "HEAD"]); return true; } catch { return false; } })();
  const dirty = git(cwd, ["status", "--porcelain", "--untracked-files=all"]).trim();
  if (scope === "auto") scope = base ? "branch" : dirty ? "working-tree" : "branch";

  let label, diff, extra = "";
  if (scope === "working-tree") {
    label = "uncommitted working-tree changes (staged + unstaged + untracked)";
    diff = hasHead ? git(cwd, ["diff", "HEAD", "--no-color"]) : git(cwd, ["diff", "--cached", "--no-color"]);
    const untracked = git(cwd, ["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean);
    for (const f of untracked) {
      let body;
      try { body = fs.readFileSync(path.join(cwd, f)); } catch { continue; }
      extra += body.includes(0) || body.length > 100_000
        ? `\n### NEW FILE ${f} (binary or large, ${body.length} bytes; open it if relevant)\n`
        : `\n### NEW FILE ${f}\n${body.toString("utf8")}\n`;
    }
  } else if (scope === "branch") {
    base = base || defaultBase(cwd);
    if (!base) throw new Error("no base branch found; pass --base <ref>");
    label = `branch changes ${base}...HEAD`;
    diff = git(cwd, ["diff", `${base}...HEAD`, "--no-color"]);
    extra = `\n### COMMITS\n${git(cwd, ["log", "--oneline", `${base}..HEAD`])}`;
  } else {
    throw new Error(`unknown --scope ${scope} (use auto|working-tree|branch)`);
  }
  const stat = scope === "branch" ? git(cwd, ["diff", "--stat", `${base}...HEAD`]) : hasHead ? git(cwd, ["diff", "--stat", "HEAD"]) : "";
  return finishContext({ label, scope, body: diff + extra, stat });
}

function finishContext(ctx) {
  if (!ctx.body.trim()) return { empty: true, label: ctx.label };
  const truncated = Buffer.byteLength(ctx.body) > MAX_DIFF_BYTES;
  const body = truncated ? Buffer.from(ctx.body).subarray(0, MAX_DIFF_BYTES).toString("utf8") : ctx.body;
  return { ...ctx, empty: false, body, truncated };
}

// GitHub pull request via the gh CLI (uses the user's existing gh auth).
function prContext(cwd, pr) {
  const gh = (args) => {
    const r = spawnSync("gh", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (r.error) throw new Error("reviewing a PR needs the GitHub CLI (gh) on PATH");
    if (r.status !== 0) throw new Error(`gh ${args.join(" ")} failed: ${(r.stderr || "").trim()}`);
    return r.stdout;
  };
  const meta = JSON.parse(gh(["pr", "view", pr, "--json", "number,title,body,baseRefName,headRefName,url"]));
  const body = `### PR #${meta.number}: ${meta.title} (${meta.headRefName} -> ${meta.baseRefName})\n${meta.url}\n\n${meta.body || ""}\n\n### DIFF\n${gh(["pr", "diff", pr])}`;
  return finishContext({ label: `pull request #${meta.number} (${meta.title})`, scope: "pr", body, stat: "" });
}

// ---------- run agy ----------

function buildAgyArgs(o, policy, models) {
  const args = ["--output-format", "stream-json"];
  if (policy === "write") args.push("--mode", "accept-edits");
  if (policy === "yolo") args.push("--dangerously-skip-permissions");
  const model = resolveModel(o.model, models || (o.model ? listModels() : []));
  if (model) args.push("--model", model);
  if (o.effort) args.push("--effort", o.effort);
  if (o.agent) args.push("--agent", o.agent);
  for (const d of o["add-dir"]) args.push("--add-dir", path.resolve(d));
  if (o.timeout) args.push("--print-timeout", /^\d+$/.test(o.timeout) ? `${o.timeout}s` : o.timeout);
  return args;
}

// Latest finished conversation worth continuing (cancelled/failed runs are skipped).
function lastResumable(cwd) {
  return listJobs(cwd).find((x) => x.conversationId && x.status === "completed" && ["task", "research", "transfer"].includes(x.kind));
}

function short(v, n = 80) {
  const s = String(v ?? "").replace(/\s+/g, " ");
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function describeTool(su) {
  const p = su.tool_info?.parameters || {};
  const arg = p.TargetFile || p.AbsolutePath || p.CommandLine || p.Query || p.query || p.Url || p.SearchPath || p.Pattern || "";
  return `${su.tool_name}${arg ? ` ${short(arg, 100)}` : ""}`;
}

// Runs agy for a stored job spec, streaming progress into the job file. Returns the finished job.
export function runJob(job) {
  return new Promise((resolve) => {
    const bin = findAgy();
    if (!bin) {
      Object.assign(job, { status: "failed", error: "agy CLI not found on PATH (set AGY_BIN or run /agy:setup)", finishedAt: new Date().toISOString() });
      saveJob(job);
      return resolve(job);
    }
    const child = spawn(bin, job.agyArgs, { cwd: job.runCwd || job.cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } });
    Object.assign(job, { status: "running", agyPid: child.pid, startedAt: new Date().toISOString() });
    saveJob(job);
    // agy may exit before reading the prompt (bad flag, auth failure); that must fail the job, not crash us.
    child.stdin.on("error", () => {});
    child.stdin.end(job.prompt);

    const log = fs.createWriteStream(logFile(job.id), { flags: "a" });
    const touched = new Set();
    let buf = "", stderr = "", result = null, lastSave = 0;
    child.on("error", (e) => { stderr += `failed to start agy: ${e.message}\n`; });

    const onLine = (line) => {
      if (!line.trim()) return;
      log.write(`${line}\n`);
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      if (ev.event === "init") job.conversationId = ev.conversation_id;
      const su = ev.step_update;
      if (su?.step_type === "tool") {
        if (su.state === "ACTIVE") job.progress = describeTool(su);
        if (su.state === "DONE" && EDIT_TOOLS.has(su.tool_name) && su.tool_info?.parameters?.TargetFile) touched.add(su.tool_info.parameters.TargetFile);
        if (su.state === "ERROR") job.progress = `${describeTool(su)} (failed)`;
        const cmd = su.tool_info?.parameters?.CommandLine;
        if (cmd && su.state !== "ACTIVE") (job.commands ||= []).push({ cmd, ok: su.state === "DONE" });
        job.steps = (job.steps || 0) + (su.state === "ACTIVE" ? 1 : 0);
      } else if (su?.step_type === "agent_response" && su.state === "ACTIVE") {
        job.progress = "writing response";
      }
      if (ev.event === "result") result = ev.result;
      if (Date.now() - lastSave > 1000) { lastSave = Date.now(); saveJob(job); }
    };

    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    child.stderr.on("data", (d) => { stderr += d; if (stderr.length > 20_000) stderr = stderr.slice(-20_000); });
    child.on("close", (code) => {
      onLine(buf);
      log.end();
      if (loadJob(job.id)?.status === "cancelled") return resolve(loadJob(job.id));
      job.exitCode = code;
      job.finishedAt = new Date().toISOString();
      job.touchedFiles = [...touched];
      job.stderr = stderr.trim().split("\n").slice(-15).join("\n");
      if (result) {
        job.conversationId = result.conversation_id || job.conversationId;
        job.result = { response: result.response || "", usage: result.usage, duration: result.duration_seconds, denied: result.denied_actions || [] };
        job.status = result.status === "SUCCESS" && code === 0 ? "completed" : "failed";
      } else {
        job.status = "failed";
      }
      if (job.status === "failed" && !job.error) job.error = job.stderr || `agy exited with code ${code}`;
      if (job.worktree) finalizeWorktree(job);
      job.artifacts = collectArtifacts(job);
      job.rendered = render(job);
      saveJob(job);
      resolve(job);
    });
  });
}

function collectArtifacts(job) {
  if (!job.conversationId) return [];
  const dir = path.join(AGY_BRAIN, job.conversationId);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const files = names.filter((n) => !n.startsWith(".") && !n.endsWith(".metadata.json") && n !== "scratch")
    .map((n) => path.join(dir, n)).filter((p) => fs.statSync(p).isFile());
  if (job.kind !== "image" || !files.length) return files;
  // Images are copied next to the user's project so Claude and the user can use them directly.
  const out = path.resolve(job.cwd, job.outDir || "agy-images");
  fs.mkdirSync(out, { recursive: true });
  return files.map((f) => {
    if (!IMAGE_EXT.test(f)) return f;
    const dest = path.join(out, path.basename(f));
    fs.copyFileSync(f, dest);
    return dest;
  });
}

// ---------- rendering ----------

const SEV = ["critical", "high", "medium", "low"];

export function renderReview(text) {
  let data;
  const m = /\{[\s\S]*\}/.exec(text || "");
  try { data = JSON.parse(m ? m[0] : text); } catch { return null; }
  if (!data || !Array.isArray(data.findings)) return null;
  const findings = [...data.findings].sort((a, b) => SEV.indexOf(a.severity) - SEV.indexOf(b.severity));
  const lines = [`**Verdict:** ${data.verdict === "approve" ? "✅ approve" : "⚠️ needs-attention"}`, "", data.summary || ""];
  if (!findings.length) lines.push("", "No findings.");
  findings.forEach((f, i) => {
    const loc = f.file ? ` — \`${f.file}${f.line_start ? `:${f.line_start}${f.line_end && f.line_end !== f.line_start ? `-${f.line_end}` : ""}` : ""}\`` : "";
    lines.push("", `### ${i + 1}. [${(f.severity || "?").toUpperCase()}] ${f.title}${loc}`);
    if (f.body) lines.push("", f.body);
    if (f.recommendation) lines.push("", `**Fix:** ${f.recommendation}`);
    if (typeof f.confidence === "number") lines.push("", `_Confidence: ${Math.round(f.confidence * 100)}%_`);
  });
  if (data.next_steps?.length) lines.push("", "## Next steps", ...data.next_steps.map((s) => `- ${s}`));
  return lines.join("\n");
}

function render(job) {
  const r = job.result;
  const head = [`# agy ${job.kind} — ${job.status}`, "",
    `- Job: \`${job.id}\`${job.conversationId ? ` · agy conversation: \`${job.conversationId}\`` : ""}`,
    `- Policy: ${job.policy}${job.model ? ` · model: ${job.model}` : ""}${r?.duration ? ` · ${Math.round(r.duration)}s` : ""}${r?.usage ? ` · ${r.usage.total_tokens} tokens` : ""}`];
  if (job.reviewLabel) head.push(`- Reviewed: ${job.reviewLabel}${job.truncated ? " (diff truncated; agy read remaining files directly)" : ""}`);
  const out = [head.join("\n"), ""];
  if (job.status === "failed") out.push("## Error", "```", job.error || "unknown error", "```", "");
  if (r?.denied?.length) {
    out.push(`> ⚠️ agy stopped because it tried a tool this run's policy does not permit: ${r.denied.map((d) => d.display_name || d.action).join(", ")}.`,
      `> Re-run with ${job.policy === "read" ? "`--write` (file edits) or " : ""}\`--yolo\` (shell + URLs) if you trust the task.`, "");
  }
  if (r?.response) out.push((job.kind === "review" && renderReview(r.response)) || r.response.trim(), "");
  else if (job.status === "completed") out.push("_agy returned an empty response._", "");
  if (job.commands?.length) out.push("## Commands agy ran", ...job.commands.map((c) => `- ${c.ok ? "✓" : "✗"} \`${short(c.cmd, 200)}\``), "");
  if (job.worktree) {
    out.push(job.patch
      ? `## Patch from isolated worktree (NOT applied yet)\n\n\`\`\`\n${job.patchStat}\n\`\`\`\n\nReview: \`git apply --stat ${job.patch}\` / read ${job.patch}\nApply: \`/agy:apply ${job.id}\``
      : "_agy made no changes in its worktree._", "");
  } else if (job.touchedFiles?.length) out.push("## Files agy edited", ...job.touchedFiles.map((f) => `- ${f}`), "");
  if (job.artifacts?.length) out.push("## agy artifacts", ...job.artifacts.map((f) => `- ${f}`), "");
  if (job.kind === "transfer" && job.conversationId) out.push(`Continue interactively in agy: \`agy --conversation ${job.conversationId}\` (run it from ${job.cwd}).`);
  if (job.conversationId && !["review", "gate"].includes(job.kind)) out.push(`_Follow up in the same agy conversation with \`/agy:task --resume-last <instructions>\`._`);
  return out.join("\n").trim();
}

// ---------- subcommands ----------

const jobId = (kind) => `${kind}-${Date.now().toString(36)}-${crypto.randomBytes(2).toString("hex")}`;

function newJob(kind, cwd, o, policy, prompt, extra = {}) {
  const models = o.model ? listModels() : [];
  const job = {
    id: jobId(kind),
    kind, cwd, policy, status: "queued", createdAt: new Date().toISOString(),
    title: short(o.text || extra.reviewLabel || kind, 70),
    model: resolveModel(o.model, models), agyArgs: buildAgyArgs(o, policy, models), prompt, ...extra,
  };
  let resumeId = o.resume || (o["resume-last"] && !o.fresh ? lastResumable(cwd)?.conversationId : null);
  if (o["resume-last"] && !o.fresh && !resumeId) throw new Error("no previous agy task in this workspace to resume");
  if (resumeId) { job.agyArgs.push("--conversation", resumeId); job.resumedFrom = resumeId; }
  return job;
}

async function launch(job, o) {
  pruneJobs();
  saveJob(job);
  if (o.background) {
    const child = spawn(process.execPath, [SELF, "_worker", job.id], { detached: true, stdio: "ignore", cwd: job.cwd });
    child.unref();
    job.pid = child.pid;
    job.status = "running";
    saveJob(job);
    return `agy ${job.kind} started in the background as \`${job.id}\`.\nCheck progress with \`/agy:status ${job.id}\` and fetch the output with \`/agy:result ${job.id}\`.`;
  }
  job.pid = process.pid;
  const done = await runJob(job);
  return o.json ? JSON.stringify(done, null, 2) : done.rendered;
}

function policyOf(o, fallback = "read") {
  return o.yolo ? "yolo" : o.write ? "write" : fallback;
}

async function cmdTask(o, cwd) {
  if (!o.text) throw new Error("task text is required");
  if (o.models) return cmdAttempts(o, cwd);
  const policy = policyOf(o, o.worktree ? "write" : "read");
  const tail = policy === "read" ? ASK_TAIL : TASK_TAIL;
  const id = jobId("task");
  const wt = o.worktree ? createWorktree(cwd, id) : null;
  const root = wt ? wt.runCwd : cwd;
  const prompt = o.resume || o["resume-last"]
    ? `${policyText(policy)}${wt ? `\nYou are now working in an isolated git worktree: ${root}. Edit files there only.` : ""}\n\nFOLLOW-UP:\n${o.text}\n\n${tail}`
    : `${preamble(root, policy, o["add-dir"])}\n\nTASK:\n${o.text}\n\n${tail}`;
  return launch(newJob("task", cwd, o, policy, prompt, { id, ...wt }), o);
}

// ---------- isolated worktrees ----------

// agy works on a throwaway worktree seeded with Claude's current uncommitted state, so parallel
// agents never clobber each other; the result comes back as a patch applied with /agy:apply.
function createWorktree(cwd, id) {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]).trim();
  git(root, ["rev-parse", "--verify", "HEAD"]);
  const worktree = path.join(DATA_DIR, "worktrees", id);
  git(root, ["worktree", "add", "--detach", worktree, "HEAD"]);
  const diff = spawnSync("git", ["diff", "HEAD", "--binary"], { cwd: root, maxBuffer: 256 * 1024 * 1024 }).stdout;
  if (diff?.length) {
    const r = spawnSync("git", ["apply", "--whitespace=nowarn"], { cwd: worktree, input: diff });
    if (r.status !== 0) throw new Error(`could not replicate uncommitted changes into the worktree: ${r.stderr}`);
  }
  for (const f of git(root, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean)) {
    fs.mkdirSync(path.dirname(path.join(worktree, f)), { recursive: true });
    fs.copyFileSync(path.join(root, f), path.join(worktree, f));
  }
  git(worktree, ["add", "-A"]);
  git(worktree, ["-c", "user.name=agy-plugin", "-c", "user.email=agy-plugin@localhost", "-c", "commit.gpgsign=false",
    "commit", "--no-verify", "--allow-empty", "-q", "-m", "agy-plugin snapshot"]);
  return { worktree, repoRoot: root, worktreeBase: git(worktree, ["rev-parse", "HEAD"]).trim(), runCwd: path.join(worktree, path.relative(root, cwd)) };
}

// Build/test by-products that should never ride along in a patch even when the repo does not ignore them.
const JUNK = ["__pycache__", "*.pyc", ".pytest_cache", ".mypy_cache", ".ruff_cache", "node_modules", ".DS_Store", ".coverage", "*.egg-info"];

function finalizeWorktree(job) {
  if (job.result?.response) job.result.response = job.result.response.split(job.runCwd).join(job.cwd).split(job.worktree).join(job.repoRoot);
  try {
    git(job.worktree, ["add", "-A", "--", ".", ...JUNK.map((p) => `:(exclude,glob)**/${p}`)]);
    const patch = spawnSync("git", ["diff", "--cached", "--binary", job.worktreeBase], { cwd: job.worktree, maxBuffer: 256 * 1024 * 1024 }).stdout;
    job.patchStat = git(job.worktree, ["diff", "--cached", "--stat", job.worktreeBase]).trim();
    if (patch?.length) {
      job.patch = path.join(JOBS_DIR, `${job.id}.patch`);
      fs.writeFileSync(job.patch, patch);
    }
  } catch (e) {
    job.error = `${job.error ? `${job.error}\n` : ""}collecting the worktree patch failed: ${e.message}`;
  }
  try { git(job.repoRoot, ["worktree", "remove", "--force", job.worktree]); } catch {}
}

function cmdApply(o, cwd) {
  const job = o.text ? findJob(o.text, cwd) : listJobs(cwd).find((j) => j.patch && !j.applied);
  if (!job) return o.text ? `No job ${o.text}.` : "No unapplied agy worktree patch in this workspace.";
  if (!job.patch || !fs.existsSync(job.patch)) return `Job \`${job.id}\` has no patch (agy made no changes, or it was not a --worktree job).`;
  if (job.applied) return `Patch from \`${job.id}\` was already applied.`;
  const run = (args) => spawnSync("git", ["apply", ...args, job.patch], { cwd: job.repoRoot, encoding: "utf8" });
  let r = run(["--check"]);
  let how = "cleanly";
  if (r.status !== 0) {
    r = run(["--3way"]);
    how = "with a 3-way merge";
    if (r.status !== 0) return `Could not apply \`${job.id}\`:\n\`\`\`\n${(r.stderr || "").trim()}\n\`\`\`\nResolve conflicts manually, or inspect the patch at ${job.patch}.`;
  } else {
    r = run([]);
    if (r.status !== 0) return `git apply failed: ${r.stderr}`;
  }
  job.applied = true;
  saveJob(job);
  return `Applied agy patch from \`${job.id}\` ${how}${/conflict/i.test(r.stderr || "") ? " (with conflicts — check `git status`)" : ""}:\n\`\`\`\n${job.patchStat}\n\`\`\``;
}

// ---------- multi-model comparison ----------

function resolveModels(list, fallback) {
  const all = listModels();
  const models = [...new Set((list || fallback).split(",").map((m) => resolveModel(m.trim(), all)).filter(Boolean))];
  if (models.length < 2) throw new Error("--models needs at least two models, e.g. --models pro,opus");
  return models;
}

// Runs one job per model in parallel (in this process) and returns them when all have finished.
async function fanOut(models, makeJob) {
  pruneJobs();
  const jobs = models.map((model) => {
    const job = makeJob(model);
    job.agyArgs.push("--model", model);
    Object.assign(job, { model, pid: process.pid });
    saveJob(job);
    return job;
  });
  return Promise.all(jobs.map(runJob));
}

// Nest a model's own Markdown headings under the per-model "##" section.
// Lines inside ``` fences are left alone: a "# comment" in a shell snippet is not a heading.
export function demote(text) {
  let fenced = false;
  return String(text || "").split("\n").map((line) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    return fenced ? line : line.replace(/^(#{1,4}) /, "##$1 ");
  }).join("\n");
}

const took = (j) => `${j.status}${j.result?.duration ? `, ${Math.round(j.result.duration)}s` : ""}`;

async function cmdCompare(o, cwd) {
  if (!o.text) throw new Error("question is required");
  const prompt = `${preamble(cwd, "read", o["add-dir"])}\n\nYou are one of several independent models answering the same question; give your own best, well-reasoned answer.\n\nQUESTION:\n${o.text}\n\n${ASK_TAIL}`;
  const done = await fanOut(resolveModels(o.models, "pro,opus,gpt"), (model) =>
    Object.assign(newJob("task", cwd, { ...o, model: null }, "read", prompt), { title: short(`[compare ${model}] ${o.text}`, 70) }));
  return [`# agy compare — ${done.length} models`, "", `Question: ${o.text}`, "",
    ...done.map((j) => `## ${j.model} (${took(j)})\n\n${j.status === "completed" ? demote(j.result.response || "_empty response_").trim() : `Error: ${j.error}`}\n`)].join("\n");
}

// Best-of-N: every model implements the task independently in its own worktree; Claude picks a patch.
async function cmdAttempts(o, cwd) {
  const policy = policyOf(o, "write");
  const done = await fanOut(resolveModels(o.models), (model) => {
    const id = jobId("task");
    const wt = createWorktree(cwd, id);
    const prompt = `${preamble(wt.runCwd, policy, o["add-dir"])}\n\nTASK:\n${o.text}\n\n${TASK_TAIL}`;
    return newJob("task", cwd, { ...o, model: null, resume: null, "resume-last": false }, policy, prompt, { id, ...wt, title: short(`[attempt ${model}] ${o.text}`, 70) });
  });
  return [`# agy attempts — ${done.length} independent implementations`, "", `Task: ${o.text}`, "",
    ...done.map((j) => [`## ${j.model} (${took(j)}) — job \`${j.id}\``, "",
      j.patch ? `\`\`\`\n${j.patchStat}\n\`\`\`\nPatch: ${j.patch} · apply with \`/agy:apply ${j.id}\`` : "_no changes_", "",
      j.status === "completed" ? demote(j.result.response).trim() : `Error: ${j.error}`, ""].join("\n"))].join("\n");
}

function pruneJobs() {
  let names = [];
  try { names = fs.readdirSync(JOBS_DIR).filter((f) => f.endsWith(".json")); } catch { return; }
  if (names.length <= MAX_JOBS) return;
  const jobs = names.map((f) => loadJob(f.slice(0, -5))).filter((j) => j && j.status !== "running")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const j of jobs.slice(0, names.length - MAX_JOBS)) {
    for (const ext of [".json", ".log", ".patch"]) fs.rmSync(path.join(JOBS_DIR, `${j.id}${ext}`), { force: true });
  }
}

async function cmdResearch(o, cwd) {
  if (!o.text) throw new Error("research question is required");
  const policy = policyOf(o);
  const prompt = `${preamble(cwd, policy, o["add-dir"])}\n\n${RESEARCH_TAIL}\n\nQUESTION:\n${o.text}`;
  return launch(newJob("research", cwd, o, policy, prompt), o);
}

async function cmdImage(o, cwd) {
  if (!o.text) throw new Error("image description is required");
  const prompt = `${preamble(cwd, "read", [])}\n\nUse the generate_image tool to create the image described below. Generate exactly what is asked (make several variations only if asked). Do not run shell commands and do not try to move or convert the files; Claude will collect them. Finish with one line per image describing it.\n\nIMAGE REQUEST:\n${o.text}`;
  return launch(newJob("image", cwd, o, "read", prompt, { outDir: o.out }), o);
}

async function cmdReview(o, cwd) {
  const ctx = collectReviewContext(cwd, { base: o.base, scope: o.scope, commit: o.commit, pr: o.pr });
  if (ctx.empty) return `Nothing to review: ${ctx.label} is empty.`;
  const prompt = `${preamble(cwd, "read", o["add-dir"])}\n\n${reviewInstructions(o.adversarial, o.text)}\n\nCHANGE UNDER REVIEW: ${ctx.label}\n${ctx.stat ? `\n### STAT\n${ctx.stat}` : ""}\n### DIFF\n${ctx.body}${ctx.truncated ? "\n\n[DIFF TRUNCATED — open the remaining changed files directly]" : ""}`;
  const job = newJob("review", cwd, { ...o, resume: null, "resume-last": false }, "read", prompt, { reviewLabel: ctx.label, truncated: ctx.truncated, adversarial: !!o.adversarial });
  job.agyArgs.push("--json-schema", REVIEW_SCHEMA);
  return launch(job, o);
}

function fmtElapsed(job) {
  const end = job.finishedAt ? Date.parse(job.finishedAt) : Date.now();
  const s = Math.max(0, Math.round((end - Date.parse(job.createdAt)) / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`;
}

// Human-readable list of the tool calls agy made, reconstructed from the stream-json log.
function readTimeline(id) {
  let text = "";
  try { text = fs.readFileSync(logFile(id), "utf8"); } catch { return []; }
  const out = [];
  for (const line of text.split("\n")) {
    let su;
    try { su = JSON.parse(line).step_update; } catch { continue; }
    if (su?.step_type !== "tool" || su.state === "ACTIVE") continue;
    const err = su.tool_info?.error?.message;
    out.push(`- ${su.state === "DONE" ? "✓" : "✗"} ${describeTool(su)}${su.duration_seconds ? ` (${su.duration_seconds.toFixed(1)}s)` : ""}${err ? ` — ${short(err, 120)}` : ""}`);
  }
  return out;
}

function cmdStatus(o, cwd) {
  if (o.text) {
    const job = findJob(o.text, cwd);
    if (!job) throw new Error(`no job ${o.text}`);
    if (o.json) return JSON.stringify(job, null, 2);
    const lines = [`# ${job.id} — ${job.status}`, `- kind: ${job.kind} · policy: ${job.policy} · elapsed: ${fmtElapsed(job)} · steps: ${job.steps || 0}`,
      `- task: ${job.title}`, job.progress ? `- last activity: ${job.progress}` : "", job.conversationId ? `- agy conversation: ${job.conversationId}` : ""];
    const timeline = readTimeline(job.id);
    if (timeline.length) lines.push("", "## Timeline", ...timeline.slice(-40));
    if (job.status === "running") lines.push("", `Cancel with \`/agy:cancel ${job.id}\`.`);
    else lines.push("", `Full output: \`/agy:result ${job.id}\``);
    return lines.filter(Boolean).join("\n");
  }
  const jobs = listJobs(cwd, o.all).slice(0, o.all ? 50 : 15).map(refresh);
  if (o.json) return JSON.stringify(jobs.map(({ prompt, rendered, ...j }) => j), null, 2);
  if (!jobs.length) return "No agy jobs for this workspace yet.";
  return ["| job | kind | status | elapsed | activity / task |", "|---|---|---|---|---|",
    ...jobs.map((j) => `| \`${j.id}\` | ${j.kind} | ${j.status} | ${fmtElapsed(j)} | ${short(j.status === "running" ? j.progress || "starting" : j.title, 60).replace(/\|/g, "\\|")} |`)].join("\n");
}

async function cmdResult(o, cwd) {
  let job = o.text ? findJob(o.text, cwd) : listJobs(cwd).map(refresh).find((j) => (o.wait ? true : j.status !== "running" && j.status !== "queued"));
  if (!job) throw new Error(o.text ? `no job ${o.text}` : "no finished agy jobs in this workspace");
  // --wait blocks until the job finishes (bounded by --timeout seconds, default 540 to fit a 10-minute Bash call).
  const deadline = Date.now() + Number(o.timeout || 540) * 1000;
  while (o.wait && ["running", "queued"].includes(job.status) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    job = refresh(loadJob(job.id));
  }
  if (job.status === "running" || job.status === "queued") return `Job \`${job.id}\` is still ${job.status} (${fmtElapsed(job)}, last activity: ${job.progress || "starting"}). Try again later or \`/agy:cancel ${job.id}\`.`;
  if (o.json) return JSON.stringify(job, null, 2);
  return job.rendered || render(job);
}

function cmdCancel(o, cwd) {
  const job = o.text ? findJob(o.text, cwd) : listJobs(cwd).map(refresh).find((j) => j.status === "running");
  if (!job) return o.text ? `No job ${o.text}.` : "No running agy job in this workspace.";
  if (job.status !== "running") return `Job \`${job.id}\` is already ${job.status}.`;
  for (const pid of [job.agyPid, job.pid]) {
    if (!pid || pid === process.pid) continue;
    try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch {} }
  }
  Object.assign(job, { status: "cancelled", finishedAt: new Date().toISOString() });
  if (job.worktree) try { git(job.repoRoot, ["worktree", "remove", "--force", job.worktree]); } catch {}
  job.rendered = render(job);
  saveJob(job);
  return `Cancelled \`${job.id}\`.`;
}

function cmdResumeCandidate(o, cwd) {
  const j = lastResumable(cwd);
  const res = j ? { available: true, jobId: j.id, conversationId: j.conversationId, title: j.title, finishedAt: j.finishedAt } : { available: false };
  return JSON.stringify(res);
}

function cmdSetup(o, cwd) {
  if (o["allow-command"]) updateAllowlist(validateAllowCommand(o["allow-command"]), true);
  if (o["revoke-command"]) updateAllowlist(String(o["revoke-command"]).trim().replace(/\s+/g, " "), false);
  if (o["enable-review-gate"] || o["disable-review-gate"]) {
    const cfg = loadConfig();
    cfg.reviewGate = cfg.reviewGate || {};
    if (o["enable-review-gate"]) cfg.reviewGate[cwd] = true; else delete cfg.reviewGate[cwd];
    saveConfig(cfg);
  }
  const bin = findAgy();
  const report = { node: process.version, agy: bin, version: null, authenticated: false, quota: null, models: [], dataDir: DATA_DIR };
  if (bin) {
    report.version = agySync(["--version"]).stdout.trim() || null;
    const u = agySync(["--output-format", "json"], "/usage");
    try {
      const data = JSON.parse(u.stdout);
      report.authenticated = data.status === "SUCCESS";
      report.quota = (data.response || "").trim();
    } catch { report.error = (u.stderr || u.stdout).trim().slice(0, 500); }
    report.models = listModels().map((m) => m.id);
  }
  if (o.json) return JSON.stringify(report, null, 2);
  const lines = ["# agy setup", "", `- node: ${report.node}`, `- agy: ${bin ? `${bin} (${report.version})` : "NOT FOUND — install the Antigravity CLI, then re-run /agy:setup"}`];
  if (bin) {
    lines.push(`- authenticated: ${report.authenticated ? "yes" : "NO — run `! agy` once and sign in"}`);
    if (report.quota) lines.push("", "## Quota", "", "| group | window | remaining | resets |", "|---|---|---|---|",
      ...report.quota.split("\n").map((l) => `| ${l.split("\t").join(" | ")} |`));
    if (report.models.length) lines.push("", "## Models (use with --model, or aliases: pro, flash, opus, sonnet, gpt)", "", ...report.models.map((m) => `- ${m}`));
    if (report.error) lines.push("", "## Error", "```", report.error, "```");
  }
  lines.push("", `- stop-time review gate for ${cwd}: ${loadConfig().reviewGate?.[cwd] ? "ENABLED" : "disabled"} (toggle with --enable-review-gate / --disable-review-gate)`);
  const cmds = allowedCommands();
  lines.push("", `- commands agy may run in every mode (from ${AGY_SETTINGS}): ${cmds.length ? cmds.map((c) => `\`${c}\``).join(", ") : "none"} (add with --allow-command "<cmd>", remove with --revoke-command "<cmd>")`);
  lines.push("", `Job data: ${DATA_DIR}`);
  return lines.join("\n");
}

// ---------- config ----------

const CONFIG_FILE = path.join(DATA_DIR, "config.json");

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); } catch { return {}; }
}

function saveConfig(cfg) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

// ---------- Claude session -> agy transfer ----------

const CLAUDE_PROJECTS = path.join(os.homedir(), ".claude", "projects");
const TRANSFER_BUDGET = 200_000; // chars; the head keeps the original goal, the tail keeps the current state.

function resolveTranscript(src) {
  if (!src) throw new Error("could not identify the current Claude transcript (the SessionStart hook sets it); pass --source <path-to-session.jsonl>");
  const p = src.startsWith("~/") ? path.join(os.homedir(), src.slice(2)) : path.resolve(src);
  if (path.extname(p) !== ".jsonl") throw new Error(`Claude transcript must be a .jsonl file: ${p}`);
  let real;
  try { real = fs.realpathSync(p); } catch { throw new Error(`Claude transcript not found: ${p} — if this is the first message of the session there is nothing to hand over yet`); }
  const rel = path.relative(fs.realpathSync(CLAUDE_PROJECTS), real);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`only transcripts under ${CLAUDE_PROJECTS} can be transferred: ${real}`);
  return real;
}

const EDIT_TOOL_NAMES = /^(Edit|Write|MultiEdit|NotebookEdit)$/;

export function condenseTranscript(text) {
  const lines = [], edited = new Set();
  for (const raw of text.split("\n")) {
    let e;
    try { e = JSON.parse(raw); } catch { continue; }
    if (e.isMeta || e.isSidechain || (e.type !== "user" && e.type !== "assistant")) continue;
    const c = e.message?.content;
    for (const b of typeof c === "string" ? [{ type: "text", text: c }] : Array.isArray(c) ? c : []) {
      if (b.type === "text" && b.text?.trim() && !b.text.startsWith("<local-command-caveat>")) {
        lines.push(`${e.type === "user" ? "USER" : "CLAUDE"}: ${b.text.trim()}`);
      } else if (b.type === "tool_use") {
        const i = b.input || {};
        const target = i.file_path || i.notebook_path;
        if (target && EDIT_TOOL_NAMES.test(b.name)) edited.add(target);
        lines.push(`CLAUDE used ${b.name}: ${short(i.command || target || i.pattern || i.url || i.description || i.prompt || JSON.stringify(i), 200)}`);
      } else if (b.type === "tool_result") {
        const t = typeof b.content === "string" ? b.content : (b.content || []).map((x) => x.text || "").join(" ");
        lines.push(`  -> ${b.is_error ? "ERROR: " : ""}${short(t, 300)}`);
      }
    }
  }
  let body = lines.join("\n");
  if (body.length > TRANSFER_BUDGET) {
    const head = 20_000;
    body = `${body.slice(0, head)}\n\n[... middle of the session omitted ...]\n\n${body.slice(body.length - (TRANSFER_BUDGET - head))}`;
  }
  return { body, edited: [...edited], entries: lines.length };
}

async function cmdTransfer(o, cwd) {
  const src = resolveTranscript(o.source || process.env.AGY_CLAUDE_TRANSCRIPT);
  const t = condenseTranscript(fs.readFileSync(src, "utf8"));
  if (!t.entries) throw new Error(`no conversation found in ${src}`);
  const prompt = `${preamble(cwd, "read", o["add-dir"])}

HANDOFF: you are taking over an in-progress Claude Code session in this workspace. Below is a condensed transcript (USER = the human, CLAUDE = the previous agent; tool outputs are truncated).
Read it, inspect the workspace files as needed to confirm the current state, and make NO changes yet. Reply with:
## Goal
## Done so far
## In progress / open problems
## Files involved
## Suggested next steps
The user will continue this conversation with you afterwards.

FILES CLAUDE EDITED: ${t.edited.length ? t.edited.join(", ") : "none"}
${o.text ? `\nUSER NOTE FOR THE HANDOFF: ${o.text}\n` : ""}
=== TRANSCRIPT (${path.basename(src)}) ===
${t.body}`;
  return launch(newJob("transfer", cwd, { ...o, text: o.text || `handoff of ${path.basename(src)}` }, "read", prompt, { source: src }), o);
}

// ---------- hooks ----------

function shellQuote(v) {
  return `'${String(v).replace(/'/g, `'\\''`)}'`;
}

// Exposes the transcript path so /agy:transfer can find the current session.
function hookSessionStart(input) {
  if (!process.env.CLAUDE_ENV_FILE) return;
  const lines = [];
  if (input.transcript_path) lines.push(`export AGY_CLAUDE_TRANSCRIPT=${shellQuote(input.transcript_path)}`);
  if (input.session_id) lines.push(`export AGY_CLAUDE_SESSION_ID=${shellQuote(input.session_id)}`);
  if (lines.length) fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `${lines.join("\n")}\n`);
}

const GATE_MAX_BLOCKS = 3;

const GATE_PROMPT = `STOP-TIME REVIEW GATE. Claude Code is about to end its turn with the uncommitted changes below in the workspace. Decide whether they are safe to stop on.
BLOCK only for concrete defects that must be fixed now: bugs, broken code or imports, security holes, data loss, clearly unfinished work (TODO stubs, half-applied edits). Do not block for style, naming, missing nice-to-haves, or speculative concerns. When in doubt, ALLOW.
Open any workspace file you need to confirm a problem before blocking.

OUTPUT CONTRACT: your first line must be exactly one of
ALLOW: <short reason>
BLOCK: <short reason>
If BLOCK, follow with one bullet per defect: \`file:line\` — problem — fix.`;

export function parseGate(text) {
  const first = String(text || "").trim().split("\n", 1)[0].trim();
  if (first.startsWith("ALLOW")) return { allow: true };
  if (first.startsWith("BLOCK")) return { allow: false, reason: String(text).trim() };
  return null;
}

async function hookStop(input) {
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const running = listJobs(cwd).map(refresh).find((j) => j.status === "running");
  if (running) console.error(`agy job ${running.id} is still running — /agy:status ${running.id}, /agy:cancel ${running.id}.`);

  const cfg = loadConfig();
  if (!cfg.reviewGate?.[cwd]) return;
  if (!findAgy()) return console.error("agy review gate skipped: agy not found (run /agy:setup).");
  let ctx;
  try { ctx = collectReviewContext(cwd, { scope: "working-tree" }); } catch { return; } // not a git repo
  if (ctx.empty) return;

  // Review each distinct working-tree state once; stop re-blocking after GATE_MAX_BLOCKS rounds.
  const key = input.session_id || cwd;
  const hash = crypto.createHash("sha256").update(ctx.body).digest("hex");
  const st = cfg.gateState?.[key] || { blocks: 0 };
  if (st.hash === hash) return;
  if (st.blocks >= GATE_MAX_BLOCKS) {
    console.error(`agy review gate: blocked ${GATE_MAX_BLOCKS} times in a row; letting this stop through. Run /agy:review for a full pass.`);
    return saveGateState(key, { hash, blocks: 0 });
  }

  const last = String(input.last_assistant_message || "").trim();
  const prompt = `${preamble(cwd, "read", [])}\n\n${GATE_PROMPT}\n${last ? `\nCLAUDE'S FINAL MESSAGE FOR THIS TURN:\n${short(last, 4000)}\n` : ""}\nCHANGES: ${ctx.label}\n${ctx.stat ? `### STAT\n${ctx.stat}\n` : ""}### DIFF\n${ctx.body}`;
  const job = await runJob(newJob("gate", cwd, { "add-dir": [], timeout: "840", text: "stop-time review gate" }, "read", prompt));
  const verdict = job.status === "completed" && parseGate(job.result?.response);
  if (!verdict) {
    // Fail open: an agy outage or quota problem must not trap the Claude session.
    return console.error(`agy review gate could not decide (job ${job.id}, ${job.status}); allowing stop. See /agy:result ${job.id}.`);
  }
  saveGateState(key, { hash, blocks: verdict.allow ? 0 : st.blocks + 1 });
  if (!verdict.allow) {
    process.stdout.write(`${JSON.stringify({ decision: "block", reason: `agy stop-time review found issues to fix before stopping (job ${job.id}):\n${verdict.reason}` })}\n`);
  }
}

function saveGateState(key, state) {
  const cfg = loadConfig();
  cfg.gateState = { ...cfg.gateState, [key]: state };
  saveConfig(cfg);
}

const COMMANDS = { task: cmdTask, review: cmdReview, research: cmdResearch, image: cmdImage, status: cmdStatus, result: cmdResult, cancel: cmdCancel, setup: cmdSetup, transfer: cmdTransfer, apply: cmdApply, compare: cmdCompare, "resume-candidate": cmdResumeCandidate };

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "_worker") {
    const job = loadJob(rest[0]);
    if (!job) process.exit(1);
    job.pid = process.pid;
    await runJob(job);
    return;
  }
  if (cmd === "hook-session-start" || cmd === "hook-stop") {
    let input = {};
    try { input = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch {}
    try { await (cmd === "hook-stop" ? hookStop : hookSessionStart)(input); }
    catch (e) { console.error(`agy hook: ${e.message}`); } // a broken hook must never trap the session
    return;
  }
  const fn = COMMANDS[cmd];
  if (!fn) {
    console.error(`usage: agy-companion <${Object.keys(COMMANDS).join("|")}> [args]`);
    process.exit(2);
  }
  // Slash commands pass "$ARGUMENTS" as one string; split it like a shell would.
  const tokens = rest.length === 1 ? tokenize(rest[0]) : rest;
  try {
    const opts = parseArgs(tokens);
    // Large context (logs, stack traces, specs) goes through a file: a single argv entry is capped at 128 KB on Linux.
    if (opts["prompt-file"]) opts.text = [opts.text, fs.readFileSync(path.resolve(opts["prompt-file"]), "utf8").trim()].filter(Boolean).join("\n\n");
    const out = await fn(opts, process.cwd());
    process.stdout.write(`${out}\n`);
  } catch (e) {
    // stdout + exit 0 on purpose: Claude Code drops the output of inline `!` commands that exit non-zero.
    process.stdout.write(`agy-companion error: ${e.message}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) main();
