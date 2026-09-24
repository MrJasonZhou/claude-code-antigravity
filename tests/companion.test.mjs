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
  {event:"step_update",step_update:{step_type:"tool",state:"DONE",tool_name:"run_command",duration_seconds:1.5,tool_info:{parameters:{CommandLine:"npm test"}}}},
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
assert.match(out, /## Commands agy ran\n- ✓ `npm test`/);
const jid = /Job: `([^`]+)`/.exec(out)[1];
assert.match(execFileSync("node", [COMPANION, "status", jid], { cwd: tmp, env, encoding: "utf8" }), /## Timeline[\s\S]*✓ run_command npm test \(1\.5s\)/);

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
// Unchanged tree after a BLOCK: the block stands (no new agy call) until the consecutive-block cap, then lets go.
assert.match(JSON.parse(stop()).reason, /off by one/);
assert.match(JSON.parse(stop()).reason, /off by one/);
assert.equal(stop(), "");
assert.equal(fs.readFileSync(path.join(tmp, "gate-calls"), "utf8"), "x");
// A change beyond the prompt's truncation window still changes the fingerprint.
const fp1 = m.worktreeFingerprint(repo);
fs.writeFileSync(path.join(repo, "big.bin"), Buffer.alloc(700_000, 1));
const fp2 = m.worktreeFingerprint(repo);
fs.writeFileSync(path.join(repo, "big.bin"), Buffer.alloc(700_000, 2)); // same size, different bytes
assert.ok(fp1 !== fp2 && fp2 !== m.worktreeFingerprint(repo));
fs.rmSync(path.join(repo, "big.bin"));

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
  if (!fs.readFileSync("a.txt","utf8").startsWith("one\\ntwo\\n") || !fs.existsSync("u.txt")) process.exit(7);
  if (input.includes("PROMPTFILE-MARKER")) { console.log(JSON.stringify({event:"result",result:{conversation_id:"pf",status:"SUCCESS",response:"saw marker"}})); return; }
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

// best-of-N: one isolated attempt per model, each with its own patch
const att = execFileSync("node", [COMPANION, "task", "--worktree --models pro,opus add a line"], { cwd: wrepo, env: wenv, encoding: "utf8" });
assert.equal((att.match(/apply with `\/agy:apply task-/g) || []).length, 2);
assert.equal(g("worktree", "list").trim().split("\n").length, 1);

// --prompt-file appends large context without going through argv
fs.writeFileSync(path.join(tmp, "ctx.txt"), "PROMPTFILE-MARKER");
assert.match(execFileSync("node", [COMPANION, "task", "--prompt-file", path.join(tmp, "ctx.txt"), "look at this log"], { cwd: wrepo, env: wenv, encoding: "utf8" }), /saw marker/);

// result --wait blocks on a detached background job until it finishes
const bg = execFileSync("node", [COMPANION, "task", "--background", "--prompt-file", path.join(tmp, "ctx.txt"), "bg"], { cwd: wrepo, env: wenv, encoding: "utf8" });
const bgId = /`(task-[^`]+)`/.exec(bg)[1];
assert.match(execFileSync("node", [COMPANION, "result", bgId, "--wait", "--timeout", "30"], { cwd: wrepo, env: wenv, encoding: "utf8" }), /saw marker/);

// CLAUDE.md is surfaced to agy as project rules
fs.writeFileSync(path.join(wrepo, "CLAUDE.md"), "rules");
const seen = path.join(tmp, "seen.txt");
fs.writeFileSync(path.join(tmp, "cat-agy"), `#!/bin/sh\ncat > ${seen}\n`, { mode: 0o755 });
execFileSync("node", [COMPANION, "task", "hi"], { cwd: wrepo, env: { ...process.env, AGY_BIN: path.join(tmp, "cat-agy") } });
assert.match(fs.readFileSync(seen, "utf8"), new RegExp(`PROJECT RULES: read ${path.join(wrepo, "CLAUDE.md")}`));

// agy exiting before reading its prompt (EPIPE) fails the job instead of crashing the companion
const big = path.join(tmp, "big.txt");
fs.writeFileSync(big, "x".repeat(2_000_000));
assert.match(execFileSync("node", [COMPANION, "task", "--prompt-file", big, "q"], { cwd: wrepo, env: { ...process.env, AGY_BIN: "/bin/false" }, encoding: "utf8" }), /# agy task — failed/);

// review --commit builds context from a single commit
const cctx = m.collectReviewContext(wrepo, { commit: "HEAD" });
assert.equal(cctx.scope, "commit");
assert.match(cctx.body, /\+one/);

assert.equal(m.demote("## R\n```sh\n# keep\n```\n# H"), "#### R\n```sh\n# keep\n```\n### H");

// ---- regression tests for the Codex review findings ----

// #12: a value flag must not swallow the next flag
assert.throws(() => m.parseArgs(["--model", "--write", "fix"]), /needs a value/);

// #1: job ids are validated; traversal never reaches the filesystem
assert.equal(m.JOB_ID.test("../../x"), false);
assert.match(execFileSync("node", [COMPANION, "status", "../../etc/passwd"], { cwd: wrepo, env: wenv, encoding: "utf8" }), /agy-companion error: no job/);
assert.match(execFileSync("node", [COMPANION, "cancel", "../x"], { cwd: wrepo, env: wenv, encoding: "utf8" }), /No job/);

// #11: corrupt config / agy settings are never overwritten
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "agy-home-"));
fs.mkdirSync(path.join(fakeHome, ".gemini", "antigravity-cli"), { recursive: true });
const settingsFile = path.join(fakeHome, ".gemini", "antigravity-cli", "settings.json");
fs.writeFileSync(settingsFile, "{ broken");
const hout = execFileSync("node", [COMPANION, "setup", "--allow-command", "npm test"], { cwd: wrepo, env: { ...wenv, HOME: fakeHome }, encoding: "utf8" });
assert.match(hout, /not valid JSON/);
assert.equal(fs.readFileSync(settingsFile, "utf8"), "{ broken");
fs.writeFileSync(settingsFile, JSON.stringify({ model: "keep-me", permissions: { allow: ["command(free)"] } }));
execFileSync("node", [COMPANION, "setup", "--allow-command", "npm test"], { cwd: wrepo, env: { ...wenv, HOME: fakeHome } });
const saved = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
assert.equal(saved.model, "keep-me");
assert.deepEqual(saved.permissions.allow, ["command(free)", "command(npm test)"]);

// #9: unborn repo — staged-then-modified content is what gets reviewed
const unborn = fs.mkdtempSync(path.join(os.tmpdir(), "agy-unborn-"));
execFileSync("git", ["init", "-q"], { cwd: unborn });
fs.writeFileSync(path.join(unborn, "app.js"), "v1\n");
execFileSync("git", ["add", "app.js"], { cwd: unborn });
fs.writeFileSync(path.join(unborn, "app.js"), "v2\n");
assert.match(m.collectReviewContext(unborn, { scope: "working-tree" }).body, /\+v2/);

// #8: untracked symlinks are recreated as links, never dereferenced into the worktree
const secret = path.join(fakeHome, "secret.txt");
fs.writeFileSync(secret, "TOP-SECRET");
fs.symlinkSync(secret, path.join(wrepo, "link"));
const linkAgy = path.join(tmp, "link-agy");
fs.writeFileSync(linkAgy, `#!/usr/bin/env node
const fs = require("fs");
if (!fs.lstatSync("link").isSymbolicLink()) process.exit(6);
fs.writeFileSync("b.txt", "b\\n");
console.log(JSON.stringify({event:"result",result:{conversation_id:"l",status:"SUCCESS",response:"ok"}}));
`, { mode: 0o755 });
const lenv = { ...process.env, AGY_BIN: linkAgy };
const lout = execFileSync("node", [COMPANION, "task", "--worktree", "add b"], { cwd: wrepo, env: lenv, encoding: "utf8" });
assert.match(lout, /completed/);
const lid = /Job: `([^`]+)`/.exec(lout)[1];
assert.doesNotMatch(fs.readFileSync(path.join(process.env.AGY_PLUGIN_DATA, "jobs", `${lid}.patch`), "utf8"), /TOP-SECRET/);
fs.rmSync(path.join(wrepo, "link"));

// #6: a conflicting patch leaves the working tree untouched unless --force
fs.writeFileSync(path.join(wrepo, "b.txt"), "conflicting local content\n");
const before = fs.readFileSync(path.join(wrepo, "b.txt"), "utf8");
assert.match(execFileSync("node", [COMPANION, "apply", lid], { cwd: wrepo, env: lenv, encoding: "utf8" }), /nothing was changed/);
assert.equal(fs.readFileSync(path.join(wrepo, "b.txt"), "utf8"), before);
fs.rmSync(path.join(wrepo, "b.txt"));
assert.equal(g("worktree", "list").trim().split("\n").length, 1); // trial worktree cleaned up

// #4/#5: cancel stops agy and its children, and the worker cleans up its worktree
const slowAgy = path.join(tmp, "slow-agy");
const childPidFile = path.join(tmp, "child.pid");
fs.writeFileSync(slowAgy, `#!/bin/sh
cat >/dev/null
sleep 300 & echo $! > ${childPidFile}
wait
`, { mode: 0o755 });
const senv = { ...process.env, AGY_BIN: slowAgy };
const sout = execFileSync("node", [COMPANION, "task", "--worktree", "--background", "slow"], { cwd: wrepo, env: senv, encoding: "utf8" });
const sid = /`(task-[^`]+)`/.exec(sout)[1];
const t0 = Date.now();
while (!fs.existsSync(childPidFile) && Date.now() - t0 < 10_000) execFileSync("sleep", ["0.1"]);
assert.match(execFileSync("node", [COMPANION, "cancel", sid], { cwd: wrepo, env: senv, encoding: "utf8" }), /Cancelled/);
const grandchild = Number(fs.readFileSync(childPidFile, "utf8"));
assert.throws(() => process.kill(grandchild, 0)); // the test-runner-like grandchild is gone too
assert.match(execFileSync("node", [COMPANION, "status", sid], { cwd: wrepo, env: senv, encoding: "utf8" }), /— cancelled/);
assert.equal(g("worktree", "list").trim().split("\n").length, 1);

console.log("ok");
