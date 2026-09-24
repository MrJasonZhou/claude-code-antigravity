#!/usr/bin/env node
// agy-companion: bridge between Claude Code and the Google Antigravity CLI (`agy`).
// Subcommands: setup | task | review | research | image | status | result | cancel | resume-candidate
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

const BOOL = new Set(["write", "yolo", "background", "wait", "json", "resume-last", "fresh", "adversarial", "all", "keep"]);
const VALUE = new Set(["model", "effort", "resume", "add-dir", "timeout", "base", "scope", "out", "agent"]);

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
  read: "TOOL POLICY: READ-ONLY. Shell commands (run_command) and URL fetching (read_url_content) are NOT permitted in this run and any attempt aborts the whole run. Do not create or modify files. Use file viewing/search tools only.",
  write: "TOOL POLICY: you MAY create and edit files inside the workspace using file-editing tools. Shell commands (run_command) and URL fetching (read_url_content) are NOT permitted in this run and any attempt aborts the whole run. Do not try to run tests or builds; instead list the exact commands Claude should run to verify your change.",
  yolo: "TOOL POLICY: full access, including shell commands and URL fetching. Stay inside the workspace. Never run destructive commands (rm -rf, git reset --hard, git push --force, dropping data) and do not commit or push.",
};

function preamble(cwd, policy, extraDirs) {
  return [
    "You are running headlessly as a delegated worker for Claude Code (another AI coding agent). No human is watching: never ask questions; make reasonable assumptions and state them in your answer.",
    `WORKSPACE ROOT (absolute): ${cwd}`,
    extraDirs.length ? `ADDITIONAL DIRECTORIES: ${extraDirs.join(", ")}` : "",
    "Resolve every relative path against the workspace root. Do not browse outside it unless the task requires it, and never read shell history, environment variables, credentials or dotfiles in the home directory.",
    POLICY[policy],
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

export function collectReviewContext(cwd, { base, scope = "auto" }) {
  git(cwd, ["rev-parse", "--is-inside-work-tree"]);
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
  let body = diff + extra;
  if (!body.trim()) return { empty: true, label };
  let truncated = false;
  if (Buffer.byteLength(body) > MAX_DIFF_BYTES) {
    body = Buffer.from(body).subarray(0, MAX_DIFF_BYTES).toString("utf8");
    truncated = true;
  }
  const stat = scope === "branch" ? git(cwd, ["diff", "--stat", `${base}...HEAD`]) : hasHead ? git(cwd, ["diff", "--stat", "HEAD"]) : "";
  return { empty: false, label, scope, body, stat, truncated };
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
  return listJobs(cwd).find((x) => x.conversationId && x.status === "completed" && ["task", "research"].includes(x.kind));
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
    const child = spawn(bin, job.agyArgs, { cwd: job.cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } });
    Object.assign(job, { status: "running", agyPid: child.pid, startedAt: new Date().toISOString() });
    saveJob(job);
    child.stdin.end(job.prompt);

    const log = fs.createWriteStream(logFile(job.id), { flags: "a" });
    const touched = new Set();
    let buf = "", stderr = "", result = null, lastSave = 0;

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
  if (job.touchedFiles?.length) out.push("## Files agy edited", ...job.touchedFiles.map((f) => `- ${f}`), "");
  if (job.artifacts?.length) out.push("## agy artifacts", ...job.artifacts.map((f) => `- ${f}`), "");
  if (job.conversationId && job.kind !== "review") out.push(`_Follow up in the same agy conversation with \`/agy:task --resume-last <instructions>\`._`);
  return out.join("\n").trim();
}

// ---------- subcommands ----------

function newJob(kind, cwd, o, policy, prompt, extra = {}) {
  const models = o.model ? listModels() : [];
  const job = {
    id: `${kind}-${Date.now().toString(36)}-${crypto.randomBytes(2).toString("hex")}`,
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
  const policy = policyOf(o);
  const tail = policy === "read" ? ASK_TAIL : TASK_TAIL;
  const prompt = o.resume || o["resume-last"]
    ? `${POLICY[policy]}\n\nFOLLOW-UP:\n${o.text}\n\n${tail}`
    : `${preamble(cwd, policy, o["add-dir"])}\n\nTASK:\n${o.text}\n\n${tail}`;
  return launch(newJob("task", cwd, o, policy, prompt), o);
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
  const ctx = collectReviewContext(cwd, { base: o.base, scope: o.scope });
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

function cmdStatus(o, cwd) {
  if (o.text) {
    const job = findJob(o.text, cwd);
    if (!job) throw new Error(`no job ${o.text}`);
    if (o.json) return JSON.stringify(job, null, 2);
    const lines = [`# ${job.id} — ${job.status}`, `- kind: ${job.kind} · policy: ${job.policy} · elapsed: ${fmtElapsed(job)} · steps: ${job.steps || 0}`,
      `- task: ${job.title}`, job.progress ? `- last activity: ${job.progress}` : "", job.conversationId ? `- agy conversation: ${job.conversationId}` : ""];
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

function cmdResult(o, cwd) {
  const job = o.text ? findJob(o.text, cwd) : listJobs(cwd).map(refresh).find((j) => j.status !== "running" && j.status !== "queued");
  if (!job) throw new Error(o.text ? `no job ${o.text}` : "no finished agy jobs in this workspace");
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
  job.rendered = render(job);
  saveJob(job);
  return `Cancelled \`${job.id}\`.`;
}

function cmdResumeCandidate(o, cwd) {
  const j = lastResumable(cwd);
  const res = j ? { available: true, jobId: j.id, conversationId: j.conversationId, title: j.title, finishedAt: j.finishedAt } : { available: false };
  return JSON.stringify(res);
}

function cmdSetup(o) {
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
  lines.push("", `Job data: ${DATA_DIR}`);
  return lines.join("\n");
}

const COMMANDS = { task: cmdTask, review: cmdReview, research: cmdResearch, image: cmdImage, status: cmdStatus, result: cmdResult, cancel: cmdCancel, setup: cmdSetup, "resume-candidate": cmdResumeCandidate };

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "_worker") {
    const job = loadJob(rest[0]);
    if (!job) process.exit(1);
    job.pid = process.pid;
    await runJob(job);
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
    const out = await fn(parseArgs(tokens), process.cwd());
    process.stdout.write(`${out}\n`);
    const job = typeof out === "string" && /^# agy \w+ — failed/.test(out);
    process.exitCode = job ? 1 : 0;
  } catch (e) {
    console.error(`agy-companion: ${e.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) main();
