#!/usr/bin/env node

import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";

const DEFAULT_TASK = "Change the background color of the notification icon to red. Implement the change, run the relevant checks, open a PR, and wait for review.";
const HARNESSES = new Set(["claude-code", "codex", "aider", "opencode", "grok", "droid", "amp", "agy", "crush", "cursor", "qwen", "copilot", "goose", "auggie", "continue", "devin", "cline", "kimi", "muse", "kiro", "kilocode", "vibe", "pi", "kimchi", "prime-agent", "autohand"]);

function help() {
  console.log(`Usage: run_agent_e2e.mjs --project ID --harness NAME [options]
  --orchestrator-harness NAME  role-specific orchestrator harness
  --reviewer-harness NAME      expected reviewer harness
  --task TEXT                  task brief
  --mode tui|chat              session interface (default tui)
  --ao PATH                    AO binary (AO_BIN, /tmp/ao, or PATH)
  --report PATH                write JSON evidence
  --poll-timeout-seconds N     timeout per stage (default 180)
  --command-timeout-seconds N timeout per command (default 120)
  --poll-interval-seconds N    poll interval (default 3)
  --tmux-lines N               pane lines to capture per session (default 160)
  --allow-unobservable         exit 0 when only observation gaps remain
  --cleanup                    kill only sessions created by this run
  -h, --help`);
}

function parseArgs(argv) {
  const o = { project: "", harness: "", orchestratorHarness: "", reviewerHarness: "", task: DEFAULT_TASK, mode: "tui", ao: "", report: "", pollTimeoutSeconds: 180, commandTimeoutSeconds: 120, pollIntervalSeconds: 3, tmuxLines: 160, allowUnobservable: false, cleanup: false };
  const flags = { "--project": "project", "--harness": "harness", "--orchestrator-harness": "orchestratorHarness", "--reviewer-harness": "reviewerHarness", "--task": "task", "--mode": "mode", "--ao": "ao", "--report": "report", "--poll-timeout-seconds": "pollTimeoutSeconds", "--command-timeout-seconds": "commandTimeoutSeconds", "--poll-interval-seconds": "pollIntervalSeconds", "--tmux-lines": "tmuxLines" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "-h" || argv[i] === "--help") return { ...o, help: true };
    if (argv[i] === "--cleanup") { o.cleanup = true; continue; }
    if (argv[i] === "--allow-unobservable") { o.allowUnobservable = true; continue; }
    const key = flags[argv[i]];
    if (!key || argv[i + 1] === undefined) throw new Error(key ? `missing value for ${argv[i]}` : `unknown option: ${argv[i]}`);
    o[key] = ["pollTimeoutSeconds", "commandTimeoutSeconds", "pollIntervalSeconds", "tmuxLines"].includes(key) ? Number(argv[++i]) : argv[++i];
  }
  if (!o.project || !o.harness) throw new Error("--project and --harness are required");
  if (o.mode !== "tui" && o.mode !== "chat") throw new Error("--mode must be tui or chat");
  if (!HARNESSES.has(o.harness)) throw new Error(`unknown harness: ${o.harness}`);
  for (const key of ["orchestratorHarness", "reviewerHarness"]) if (o[key] && !HARNESSES.has(o[key])) throw new Error(`unknown ${key}: ${o[key]}`);
  for (const key of ["pollTimeoutSeconds", "commandTimeoutSeconds", "pollIntervalSeconds", "tmuxLines"]) if (!Number.isFinite(o[key]) || o[key] <= 0) throw new Error(`${key} must be positive`);
  return o;
}

function expandHome(value) { return value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value; }
async function findExecutable(candidate) {
  const expanded = expandHome(candidate);
  if (isAbsolute(expanded) || expanded.includes("/")) { try { await access(resolve(expanded), fsConstants.X_OK); return resolve(expanded); } catch { return ""; } }
  for (const dir of (process.env.PATH ?? "").split(delimiter)) { if (!dir) continue; const path = join(dir, expanded); try { await access(path, fsConstants.X_OK); return path; } catch {} }
  return "";
}
async function resolveAo(explicit) { const candidate = explicit || process.env.AO_BIN || (await findExecutable("/tmp/ao") ? "/tmp/ao" : "ao"); const found = await findExecutable(candidate); if (!found) throw new Error(`AO CLI not found: ${candidate}`); return found; }

function runCommand(argv, timeoutSeconds) {
  return new Promise((done) => {
    let out = "", err = "", timedOut = false, finished = false;
    const started = Date.now(); const child = spawn(argv[0], argv.slice(1), { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutSeconds * 1000);
    const finish = (code, extra = "") => { if (finished) return; finished = true; clearTimeout(timer); if (extra) err += `\n${extra}`; done({ argv, code, stdout: out.trim(), stderr: err.trim(), timedOut, seconds: Number(((Date.now() - started) / 1000).toFixed(3)) }); };
    child.stdout.on("data", (x) => { out += x; }); child.stderr.on("data", (x) => { err += x; }); child.once("error", (x) => finish(null, x.message)); child.once("close", (code) => finish(code));
  });
}
function json(text) { try { return JSON.parse(text); } catch { return null; } }
function strings(value, result = []) { if (typeof value === "string") result.push(value); else if (Array.isArray(value)) value.forEach((x) => strings(x, result)); else if (value && typeof value === "object") Object.values(value).forEach((x) => strings(x, result)); return result; }
function sessionFrom(payload) { return payload?.session ?? null; }
function itemsFrom(payload) { return payload?.data ?? payload?.sessions ?? []; }
function hasTaskEvidence(payload, task) { return strings(payload).some((x) => x.includes(task)); }
function classifyTaskEvidence(payload, task) { return hasTaskEvidence(payload, task) ? "observed" : "unobservable"; }
function firstPR(session) { return Array.isArray(session?.prs) && session.prs.length ? session.prs[0] : null; }
function reviewCompleted(latest) { return latest && (latest.status === "delivered" || latest.status === "submitted" || latest.verdict === "approved" || latest.verdict === "changes_requested"); }
function markUnobservable(record, reason) {
  record.status = "unobservable";
  record.reason = reason;
}
function visibleBlockingPrompt(output) {
  if (!output) return false;
  const normalized = output.toLowerCase();
  return (
    normalized.includes("waiting for approval") ||
    normalized.includes("run this command?") ||
    normalized.includes("allow this command") ||
    normalized.includes("approve") ||
    normalized.includes("permission required") ||
    normalized.includes("permission prompt") ||
    normalized.includes("do you want to proceed") ||
    normalized.includes("press enter") ||
    normalized.includes("hit enter") ||
    /\[(y|yes)\/(n|no)\]/i.test(output) ||
    /\((y|yes)\)/i.test(output)
  );
}
async function readPromptArtifact(dataDir, sessionID) {
  if (!dataDir) return { status: "unobservable", reason: "ao status did not expose dataDir" };
  const path = join(resolve(expandHome(dataDir)), "prompts", sessionID, "system.md");
  try {
    const body = await readFile(path, "utf8");
    return { status: body.trim() ? "observed" : "failed", path, bytes: Buffer.byteLength(body), body };
  } catch (error) {
    return { status: "unobservable", path, reason: error.message };
  }
}
async function apiJSON(port, method, apiPath, body) {
  if (!port) throw new Error("ao status did not expose daemon port");
  const url = `http://127.0.0.1:${port}/api/v1${apiPath}`;
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = {};
  if (text.trim()) {
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  }
  if (!res.ok) throw new Error(`${method} ${apiPath} failed with HTTP ${res.status}: ${text}`);
  return parsed;
}

async function save(report, path) {
  if (!path) return;
  const target = resolve(expandHome(path)); await mkdir(dirname(target), { recursive: true }); const tmp = `${target}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(report, null, 2)}\n`); await rename(tmp, target);
}

async function main() {
  let options; try { options = parseArgs(process.argv.slice(2)); } catch (error) { console.error(`configuration error: ${error.message}`); return 2; }
  if (options.help) { help(); return 0; }
  const report = { startedAt: new Date().toISOString(), options, stages: [], sessions: [], cleanup: { requested: options.cleanup, results: [] } };
  let ao; try { ao = await resolveAo(options.ao); } catch (error) { report.failure = { stage: "preflight", reason: error.message }; await save(report, options.report); console.error(error.message); return 2; }
  const created = [];
  const command = (args) => runCommand([ao, ...args], options.commandTimeoutSeconds);
  async function run(record, args, parse = false) { const result = await command(args); record.evidence.push({ command: [ao, ...args], result }); if (result.code !== 0) throw new Error(`${args.join(" ")}: ${result.stderr || result.stdout || `exit ${result.code}`}`); return parse ? json(result.stdout) : result.stdout; }
  async function captureTmux(record, sessionID, label = "tmux") {
    const target = `${sessionID}:0.0`;
    const has = await runCommand(["tmux", "has-session", "-t", sessionID], options.commandTimeoutSeconds);
    const evidence = { label, target, hasSession: has.code === 0, hasSessionResult: has };
    if (has.code === 0) {
      const pane = await runCommand(["tmux", "capture-pane", "-t", target, "-p", "-S", `-${options.tmuxLines}`], options.commandTimeoutSeconds);
      evidence.captureResult = pane;
      evidence.visibleBlockingPrompt = visibleBlockingPrompt(pane.stdout);
    }
    record.evidence.push({ tmux: evidence });
    return evidence;
  }
  async function getSessionDetail(record, sessionID) {
    const status = report.stages[0]?.observed?.status ?? {};
    if (status.port) {
      try {
        const payload = await apiJSON(status.port, "GET", `/sessions/${encodeURIComponent(sessionID)}`);
        record.evidence.push({ api: { method: "GET", path: `/sessions/${sessionID}` }, observed: payload });
        return payload;
      } catch (error) {
        record.evidence.push({ api: { method: "GET", path: `/sessions/${sessionID}` }, error: error.message });
      }
    }
    return run(record, ["session", "get", sessionID, "--json"], true);
  }
  async function poll(record, label, read, predicate) { const deadline = Date.now() + options.pollTimeoutSeconds * 1000; let last; while (Date.now() < deadline) { last = await read(); record.evidence.push({ poll: label, observed: last }); if (predicate(last)) return last; await new Promise((done) => setTimeout(done, options.pollIntervalSeconds * 1000)); } throw new Error(`${label} timed out; last observed: ${JSON.stringify(last)}`); }
  async function stage(name, fn) { const record = { name, status: "running", startedAt: new Date().toISOString(), evidence: [] }; report.stages.push(record); try { await fn(record); if (record.status === "running") record.status = "passed"; } catch (error) { record.status = "failed"; record.reason = error.message; report.failure ??= { stage: name, reason: error.message }; } record.finishedAt = new Date().toISOString(); return record; }

  await stage("preflight", async (r) => { r.observed = { ao, version: await run(r, ["version"]), status: await run(r, ["status", "--json"], true), project: await run(r, ["project", "get", options.project, "--json"], true), harness: options.harness, baselineSessions: await run(r, ["session", "ls", "--project", options.project, "--all", "--json"], true) }; });
  if (report.failure) return finish(report, options, created, command);
  const baseline = new Set(itemsFrom(report.stages[0]?.observed?.baselineSessions).map((x) => x.id));
  await stage("orchestrator", async (r) => { const text = await run(r, ["spawn", "--project", options.project, "--kind", "orchestrator", "--mode", options.mode, "--harness", options.orchestratorHarness || options.harness, "--name", "e2e-orchestrator", "--prompt", options.task]); const match = text.match(/spawned session ([A-Za-z0-9_-]+)/); if (!match) throw new Error(`could not parse session ID: ${text}`); created.push(match[1]); report.sessions.push({ role: "orchestrator", id: match[1], harness: options.orchestratorHarness || options.harness, mode: options.mode }); const payload = await poll(r, "orchestrator session", () => getSessionDetail(r, match[1]), (x) => sessionFrom(x)?.isTerminated === false); const promptArtifact = await readPromptArtifact(report.stages[0]?.observed?.status?.dataDir, match[1]); const promptText = promptArtifact.body || ""; delete promptArtifact.body; const tmux = await captureTmux(r, match[1], "orchestrator"); r.observed = { session: payload, taskEvidence: classifyTaskEvidence(payload, options.task), promptArtifact, rolePromptMarker: promptText.includes("AO Orchestrator Role") ? "observed" : "unobservable", promptBytesReported: text.includes("prompt "), systemPromptBytesReported: text.includes("system "), mode: options.mode, tmux: { hasSession: tmux.hasSession, visibleBlockingPrompt: tmux.visibleBlockingPrompt ?? false } }; if (promptArtifact.status === "failed") throw new Error(`orchestrator prompt artifact is empty: ${promptArtifact.path}`); if (tmux.visibleBlockingPrompt) markUnobservable(r, "orchestrator tmux pane appears blocked on a prompt"); if (!r.observed.promptBytesReported || !r.observed.systemPromptBytesReported || (r.observed.taskEvidence !== "observed" && promptArtifact.status !== "observed")) markUnobservable(r, "orchestrator prompt/task evidence is not fully observable through CLI/API/prompt artifacts"); });
  if (report.failure) return finish(report, options, created, command);
  await stage("delegation-and-worker", async (r) => { const payload = await poll(r, "worker delegation", () => run(r, ["session", "ls", "--project", options.project, "--all", "--json"], true), (x) => itemsFrom(x).some((item) => item.kind !== "orchestrator" && !baseline.has(item.id) && !item.isTerminated)); const worker = itemsFrom(payload).find((x) => x.kind !== "orchestrator" && !baseline.has(x.id) && !x.isTerminated); created.push(worker.id); report.sessions.push({ role: "worker", id: worker.id, harness: worker.harness || options.harness }); const detail = await getSessionDetail(r, worker.id); const workerSession = sessionFrom(detail); const promptArtifact = await readPromptArtifact(report.stages[0]?.observed?.status?.dataDir, worker.id); const promptText = promptArtifact.body || ""; delete promptArtifact.body; const tmux = await captureTmux(r, worker.id, "worker"); r.observed = { worker, session: detail, taskEvidence: classifyTaskEvidence(detail, options.task), promptArtifact, rolePromptMarker: promptText.includes("AO Worker Role") ? "observed" : "unobservable", activity: workerSession?.activity, status: workerSession?.status, branch: workerSession?.branch, tmux: { hasSession: tmux.hasSession, visibleBlockingPrompt: tmux.visibleBlockingPrompt ?? false } }; if (promptArtifact.status === "failed") throw new Error(`worker prompt artifact is empty: ${promptArtifact.path}`); if (tmux.visibleBlockingPrompt) markUnobservable(r, "worker tmux pane appears blocked on a prompt"); if (r.observed.taskEvidence !== "observed" && promptArtifact.status !== "observed") markUnobservable(r, "worker task prompt is not visible through session CLI/API JSON or prompt artifact"); });
  if (report.failure) return finish(report, options, created, command);
  await stage("work-kanban-and-pr", async (r) => { const worker = report.sessions.find((x) => x.role === "worker"); const payload = await poll(r, "worker activity or PR", () => getSessionDetail(r, worker.id), (x) => { const s = sessionFrom(x); return Boolean(firstPR(s) || ["working", "pr_open", "draft", "review_pending", "changes_requested", "approved", "mergeable", "merged"].includes(s?.status)); }); const session = sessionFrom(payload); const pr = firstPR(session); const tmux = await captureTmux(r, worker.id, "worker-work"); r.observed = { session: payload, activity: session?.activity, status: session?.status, branch: session?.branch, pr, scmStatus: session?.scmStatus, tmux: { hasSession: tmux.hasSession, visibleBlockingPrompt: tmux.visibleBlockingPrompt ?? false } }; if (!session?.activity?.state && !session?.status) throw new Error("worker session exposes neither activity nor status"); if (tmux.visibleBlockingPrompt) markUnobservable(r, "worker tmux pane appears blocked during work/PR polling"); if (!session?.branch) markUnobservable(r, "worker branch/worktree metadata is not observable through CLI/API"); if (!pr) markUnobservable(r, "worker PR facts are not observable yet; continue polling manually or inspect the worker branch/worktree"); });
  if (report.failure) return finish(report, options, created, command);
  await stage("reviewer", async (r) => { const worker = report.sessions.find((x) => x.role === "worker"); const payload = await poll(r, "review result", () => run(r, ["review", "ls", worker.id, "--json"], true), (x) => x?.reviews?.some((review) => reviewCompleted(review.latestRun))); const review = payload.reviews.find((item) => reviewCompleted(item.latestRun)); const latest = review.latestRun; const tmux = latest.sessionId ? await captureTmux(r, latest.sessionId, "reviewer") : null; r.observed = { reviews: payload, selected: review, tmux: tmux ? { hasSession: tmux.hasSession, visibleBlockingPrompt: tmux.visibleBlockingPrompt ?? false } : null }; report.sessions.push({ role: "reviewer", id: latest.sessionId, reviewRunId: latest.id, harness: latest.harness || options.reviewerHarness || "configured-by-AO", verdict: latest.verdict, status: latest.status }); if (tmux?.visibleBlockingPrompt) markUnobservable(r, "reviewer tmux pane appears blocked on a prompt"); if (!latest.sessionId || !latest.verdict || latest.verdict === "none") markUnobservable(r, "review run exists but reviewer session or verdict is not exposed"); });
  return finish(report, options, created, command);
}

async function finish(report, options, created, command) {
  if (options.cleanup) for (const id of [...created].reverse()) report.cleanup.results.push({ id, result: await command(["session", "kill", id]) });
  report.finishedAt = new Date().toISOString(); await save(report, options.report);
  const counts = report.stages.reduce((a, x) => { a[x.status] = (a[x.status] || 0) + 1; return a; }, {});
  console.log(`AO agent E2E: ${counts.passed || 0} passed, ${counts.unobservable || 0} unobservable, ${counts.failed || 0} failed`); if (options.report) console.log(`Report: ${resolve(expandHome(options.report))}`); if (report.failure) { console.error(`Failed at ${report.failure.stage}: ${report.failure.reason}`); return 1; }
  if ((counts.unobservable || 0) > 0 && !options.allowUnobservable) {
    console.error("Unobservable evidence is non-passing by default. Re-run with --allow-unobservable only for diagnostic baselines.");
    return 1;
  }
  return 0;
}

main().then((code) => { process.exitCode = code; }).catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
