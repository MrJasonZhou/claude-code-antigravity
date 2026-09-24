// Run: node tests/companion.test.mjs   (uses a fake agy binary; no network, no quota)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const COMPANION = path.join(here, "..", "plugins", "agy", "scripts", "agy-companion.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-test-"));
process.env.AGY_PLUGIN_DATA = path.join(tmp, "data");
const m = await import(COMPANION);

// tokenize / parseArgs
assert.deepEqual(m.tokenize(`--write "fix it" don't 'a b'`), ["--write", "fix it", "don't", "a b"]);
const o = m.parseArgs(["--background", "--model=pro", "--add-dir", "x", "--add-dir", "y", "explain", "auth"]);
assert.equal(o.background, true);
assert.equal(o.model, "pro");
assert.deepEqual(o["add-dir"], ["x", "y"]);
assert.equal(o.text, "explain auth");

// resolveModel prefers the -high variant, passes unknown ids through
const models = [{ id: "gemini-3.1-pro-low" }, { id: "gemini-3.1-pro-high" }, { id: "claude-opus-4-6-thinking" }];
assert.equal(m.resolveModel("pro", models), "gemini-3.1-pro-high");
assert.equal(m.resolveModel("opus", models), "claude-opus-4-6-thinking");
assert.equal(m.resolveModel("my-custom", models), "my-custom");

// renderReview sorts by severity and tolerates prose around the JSON
const review = m.renderReview(`here: ${JSON.stringify({ verdict: "needs-attention", summary: "s", next_steps: [],
  findings: [{ severity: "low", title: "L", file: "a.py", line_start: 1, body: "b", recommendation: "r", confidence: 0.5 },
    { severity: "critical", title: "C", file: "b.py", line_start: 2, line_end: 4, body: "b", recommendation: "r", confidence: 1 }] })}`);
assert.ok(review.indexOf("[CRITICAL] C") < review.indexOf("[LOW] L"));
assert.match(review, /`b\.py:2-4`/);
assert.equal(m.renderReview("not json"), null);

// Full run against a fake agy: stream-json parsing, touched files, denied actions, job persistence.
const fake = path.join(tmp, "agy");
fs.writeFileSync(fake, `#!/usr/bin/env node
const lines = [
  {event:"init",conversation_id:"c-1"},
  {event:"step_update",step_update:{step_type:"tool",state:"ACTIVE",tool_name:"write_to_file",tool_info:{parameters:{TargetFile:"/w/a.py"}}}},
  {event:"step_update",step_update:{step_type:"tool",state:"DONE",tool_name:"write_to_file",tool_info:{parameters:{TargetFile:"/w/a.py"}}}},
  {event:"result",result:{conversation_id:"c-1",status:"SUCCESS",response:"did it",duration_seconds:3,usage:{total_tokens:42},denied_actions:[{action:"command",display_name:"RunCommand"}]}}];
let input=""; process.stdin.on("data",d=>input+=d); process.stdin.on("end",()=>{
  if(!input.includes("WORKSPACE ROOT")) process.exit(9);
  if(!process.argv.includes("accept-edits")) process.exit(8);
  for (const l of lines) console.log(JSON.stringify(l)); });
`, { mode: 0o755 });
const env = { ...process.env, AGY_BIN: fake };
const out = execFileSync("node", [COMPANION, "task", "--write add a feature"], { cwd: tmp, env, encoding: "utf8" });
assert.match(out, /# agy task — completed/);
assert.match(out, /did it/);
assert.match(out, /- \/w\/a\.py/);
assert.match(out, /tried a tool this run's policy does not permit: RunCommand/);

const status = execFileSync("node", [COMPANION, "status"], { cwd: tmp, env, encoding: "utf8" });
assert.match(status, /\| task \| completed \|/);
const cand = JSON.parse(execFileSync("node", [COMPANION, "resume-candidate"], { cwd: tmp, env, encoding: "utf8" }));
assert.equal(cand.conversationId, "c-1");

// review with nothing to review
execFileSync("git", ["init", "-q"], { cwd: tmp });
fs.rmSync(path.join(tmp, "agy"));
fs.rmSync(path.join(tmp, "data"), { recursive: true });
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "agy-repo-"));
execFileSync("git", ["init", "-q"], { cwd: repo });
assert.match(execFileSync("node", [COMPANION, "review", "--scope working-tree"], { cwd: repo, env, encoding: "utf8" }), /Nothing to review/);

// condenseTranscript: keeps user/assistant text + tool one-liners, drops meta/thinking, tracks edited files
const jsonl = [
  { type: "user", isMeta: true, message: { content: "meta" } },
  { type: "user", message: { content: "build a thing" } },
  { type: "assistant", message: { content: [{ type: "thinking", thinking: "secret" }, { type: "text", text: "on it" },
    { type: "tool_use", name: "Edit", input: { file_path: "/w/x.py" } }] } },
  { type: "user", message: { content: [{ type: "tool_result", content: "boom", is_error: true }] } },
  { type: "summary" },
].map((e) => JSON.stringify(e)).join("\n");
const t = m.condenseTranscript(jsonl);
assert.deepEqual(t.edited, ["/w/x.py"]);
assert.match(t.body, /USER: build a thing/);
assert.match(t.body, /CLAUDE used Edit: \/w\/x\.py/);
assert.match(t.body, /ERROR: boom/);
assert.doesNotMatch(t.body, /secret|meta/);

// parseGate
assert.deepEqual(m.parseGate("ALLOW: fine"), { allow: true });
assert.equal(m.parseGate("BLOCK: bug\n- a.py:1").allow, false);
assert.equal(m.parseGate("hmm"), null);

// Stop hook: disabled -> silent; enabled -> fake agy BLOCKs once, same tree state is not re-reviewed.
const gateAgy = path.join(tmp, "gate-agy");
fs.writeFileSync(gateAgy, `#!/usr/bin/env node
require("fs").appendFileSync(${JSON.stringify(path.join(tmp, "gate-calls"))}, "x");
console.log(JSON.stringify({event:"result",result:{conversation_id:"g",status:"SUCCESS",response:"BLOCK: off by one\\n- a.py:1 — bug — fix"}}));
`, { mode: 0o755 });
fs.writeFileSync(path.join(repo, "a.py"), "x = 1\n");
const genv = { ...process.env, AGY_BIN: gateAgy };
const stop = () => execFileSync("node", [COMPANION, "hook-stop"], { cwd: repo, env: genv, encoding: "utf8", input: JSON.stringify({ cwd: repo, session_id: "s1" }) });
assert.equal(stop(), "");
execFileSync("node", [COMPANION, "setup", "--enable-review-gate"], { cwd: repo, env: genv });
fs.rmSync(path.join(tmp, "gate-calls")); // setup itself calls agy for version/quota/models
const blocked = JSON.parse(stop());
assert.equal(blocked.decision, "block");
assert.match(blocked.reason, /off by one/);
assert.equal(stop(), ""); // unchanged tree: not reviewed again
assert.equal(fs.readFileSync(path.join(tmp, "gate-calls"), "utf8"), "x");

// allowlist validation
assert.equal(m.validateAllowCommand("  npm   test "), "npm test");
assert.throws(() => m.validateAllowCommand("python3"), /too broad/);
assert.throws(() => m.validateAllowCommand("npm test && rm -rf /"), /metacharacters/);
assert.deepEqual(m.allowedCommands({ permissions: { allow: ["command(npm test)", "read_file(/x)", "command(*)"] } }), ["npm test"]);

// --worktree: agy edits an isolated copy seeded with uncommitted + untracked state; /agy:apply brings the patch back.
const wrepo = fs.mkdtempSync(path.join(os.tmpdir(), "agy-wt-"));
const g = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: wrepo, encoding: "utf8" });
g("init", "-q");
fs.writeFileSync(path.join(wrepo, "a.txt"), "one\n");
g("add", "."); g("commit", "-qm", "init");
fs.writeFileSync(path.join(wrepo, "a.txt"), "one\ntwo\n");       // uncommitted edit
fs.writeFileSync(path.join(wrepo, "u.txt"), "untracked\n");      // untracked file
const editAgy = path.join(tmp, "edit-agy");
fs.writeFileSync(editAgy, `#!/usr/bin/env node
const fs = require("fs");
if (process.argv[2] === "models") { console.log("gemini-x-pro-high\\tPro\\nclaude-opus-x\\tOpus"); process.exit(0); }
let input = ""; process.stdin.on("data", d => input += d); process.stdin.on("end", () => {
  if (input.includes("independent models")) {
    const m = process.argv[process.argv.indexOf("--model") + 1];
    console.log(JSON.stringify({event:"result",result:{conversation_id:"cmp",status:"SUCCESS",response:"answer from " + m}}));
    return;
  }
  // seeded state must be visible inside the worktree
  if (fs.readFileSync("a.txt","utf8") !== "one\\ntwo\\n" || !fs.existsSync("u.txt")) process.exit(7);
  fs.appendFileSync("a.txt", "three\\n");
  fs.mkdirSync("__pycache__", { recursive: true }); fs.writeFileSync("__pycache__/a.pyc", "junk");
  console.log(JSON.stringify({event:"result",result:{conversation_id:"w",status:"SUCCESS",response:"edited"}}));
});
`, { mode: 0o755 });
const wenv = { ...process.env, AGY_BIN: editAgy };
const wout = execFileSync("node", [COMPANION, "task", "--worktree add a line"], { cwd: wrepo, env: wenv, encoding: "utf8" });
assert.match(wout, /Patch from isolated worktree \(NOT applied yet\)/);
assert.doesNotMatch(wout, /pycache/); // test by-products never ride along
assert.equal(fs.readFileSync(path.join(wrepo, "a.txt"), "utf8"), "one\ntwo\n"); // main tree untouched
assert.match(execFileSync("node", [COMPANION, "apply"], { cwd: wrepo, env: wenv, encoding: "utf8" }), /Applied agy patch/);
assert.equal(fs.readFileSync(path.join(wrepo, "a.txt"), "utf8"), "one\ntwo\nthree\n");
assert.match(execFileSync("node", [COMPANION, "apply"], { cwd: wrepo, env: wenv, encoding: "utf8" }), /No unapplied/);
assert.equal(g("worktree", "list").trim().split("\n").length, 1); // throwaway worktree removed

// compare: same question to several models in parallel
const cmp = execFileSync("node", [COMPANION, "compare", "--models pro,opus which is better?"], { cwd: wrepo, env: wenv, encoding: "utf8" });
assert.match(cmp, /## gemini-x-pro-high[\s\S]*answer from gemini-x-pro-high/);
assert.match(cmp, /## claude-opus-x[\s\S]*answer from claude-opus-x/);

// review --commit builds context from a single commit
const cctx = m.collectReviewContext(wrepo, { commit: "HEAD" });
assert.equal(cctx.scope, "commit");
assert.match(cctx.body, /\+one/);

console.log("ok");
