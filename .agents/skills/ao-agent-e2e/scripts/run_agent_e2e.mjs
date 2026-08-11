#!/usr/bin/env node

import { access, mkdir, rename, writeFile } from "node:fs/promises";
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
  --ao PATH                    AO binary (AO_BIN, /tmp/ao, or PATH)
  --report PATH                write JSON evidence
  --poll-timeout-seconds N     timeout per stage (default 180)
  --command-timeout-seconds N timeout per command (default 120)
  --poll-interval-seconds N    poll interval (default 3)
  --cleanup                    kill only sessions created by this run
  -h, --help`);
}

function parseArgs(argv) {
  const o = { project: "", harness: "", orchestratorHarness: "", reviewerHarness: "", task: DEFAULT_TASK, ao: "", report: "", pollTimeoutSeconds: 180, commandTimeoutSeconds: 120, pollIntervalSeconds: 3, cleanup: false };
  const flags = { "--project": "project", "--harness": "harness", "--orchestrator-harness": "orchestratorHarness", "--reviewer-harness": "reviewerHarness", "--task": "task", "--ao": "ao", "--report": "report", "--poll-timeout-seconds": "pollTimeoutSeconds", "--command-timeout-seconds": "commandTimeoutSeconds", "--poll-interval-seconds": "pollIntervalSeconds" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "-h" || argv[i] === "--help") return { ...o, help: true };
    if (argv[i] === "--cleanup") { o.cleanup = true; continue; }
    const key = flags[argv[i]];
    if (!key || argv[i + 1] === undefined) throw new Error(key ? `missing value for ${argv[i]}` : `unknown option: ${argv[i]}`);
    o[key] = ["pollTimeoutSeconds", "commandTimeoutSeconds", "pollIntervalSeconds"].includes(key) ? Number(argv[++i]) : argv[++i];
  }
  if (!o.project || !o.harness) throw new Error("--project and --harness are required");
  if (!HARNESSES.has(o.harness)) throw new Error(`unknown harness: ${o.harness}`);
  for (const key of ["pollTimeoutSeconds", "commandTimeoutSeconds", "pollIntervalSeconds"]) if (!Number.isFinite(o[key]) || o[key] <= 0) throw new Error(`${key} must be positive`);
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
  async function poll(record, label, read, predicate) { const deadline = Date.now() + options.pollTimeoutSeconds * 1000; let last; while (Date.now() < deadline) { last = await read(); record.evidence.push({ poll: label, observed: last }); if (predicate(last)) return last; await new Promise((done) => setTimeout(done, options.pollIntervalSeconds * 1000)); } throw new Error(`${label} timed out; last observed: ${JSON.stringify(last)}`); }
  async function stage(name, fn) { const record = { name, status: "running", startedAt: new Date().toISOString(), evidence: [] }; report.stages.push(record); try { await fn(record); if (record.status === "running") record.status = "passed"; } catch (error) { record.status = "failed"; record.reason = error.message; report.failure ??= { stage: name, reason: error.message }; } record.finishedAt = new Date().toISOString(); return record; }

  await stage("preflight", async (r) => { r.observed = { ao, version: await run(r, ["version"]), status: await run(r, ["status"], true), project: await run(r, ["project", "get", options.project, "--json"], true), harness: options.harness }; });
  if (report.failure) return finish(report, options, created, command);
  await stage("orchestrator", async (r) => { const text = await run(r, ["spawn", "--project", options.project, "--kind", "orchestrator", "--mode", "chat", "--harness", options.orchestratorHarness || options.harness, "--name", "e2e-orchestrator", "--prompt", options.task]); const match = text.match(/spawned session ([A-Za-z0-9_-]+)/); if (!match) throw new Error(`could not parse session ID: ${text}`); created.push(match[1]); report.sessions.push({ role: "orchestrator", id: match[1], harness: options.orchestratorHarness || options.harness }); const payload = await poll(r, "orchestrator session", () => run(r, ["session", "get", match[1], "--json"], true), (x) => sessionFrom(x)?.isTerminated === false); const observedStrings = strings(payload); r.observed = { session: payload, exactTaskVisible: observedStrings.some((x) => x.includes(options.task)), promptBytesReported: text.includes("prompt "), systemPromptBytesReported: text.includes("system ") }; if (!r.observed.promptBytesReported || !r.observed.systemPromptBytesReported || !r.observed.exactTaskVisible) r.status = "unobservable"; });
  if (report.failure) return finish(report, options, created, command);
  await stage("delegation-and-worker", async (r) => { const before = await run(r, ["session", "ls", "--project", options.project, "--all", "--json"], true); const known = new Set(itemsFrom(before).map((x) => x.id)); const payload = await poll(r, "worker delegation", () => run(r, ["session", "ls", "--project", options.project, "--all", "--json"], true), (x) => itemsFrom(x).some((item) => item.kind !== "orchestrator" && !known.has(item.id) && !item.isTerminated)); const worker = itemsFrom(payload).find((x) => x.kind !== "orchestrator" && !known.has(x.id) && !x.isTerminated); created.push(worker.id); report.sessions.push({ role: "worker", id: worker.id, harness: worker.harness || options.harness }); r.observed = { worker, exactTaskVisible: false, taskEvidence: "unobservable from session CLI JSON" }; r.status = "unobservable"; });
  await stage("work-and-kanban", async (r) => { const worker = report.sessions.find((x) => x.role === "worker"); const payload = await run(r, ["session", "get", worker.id, "--json"], true); r.observed = { session: payload, activity: sessionFrom(payload)?.activity, status: sessionFrom(payload)?.status, fileChange: "unobservable without a worktree path in CLI JSON", kanban: "unobservable unless tracker facts are exposed in session JSON" }; r.status = "unobservable"; });
  await stage("pr-and-reviewer", async (r) => { const worker = report.sessions.find((x) => x.role === "worker"); const payload = await run(r, ["review", "ls", worker.id, "--json"], true); const latest = payload?.reviews?.[0]?.latestRun; r.observed = { reviews: payload }; if (!latest) { r.status = "unobservable"; return; } report.sessions.push({ role: "reviewer", id: latest.sessionId, reviewRunId: latest.id, harness: options.reviewerHarness || "configured-by-AO" }); });
  return finish(report, options, created, command);
}

async function finish(report, options, created, command) {
  if (options.cleanup) for (const id of [...created].reverse()) report.cleanup.results.push({ id, result: await command(["session", "kill", id]) });
  report.finishedAt = new Date().toISOString(); await save(report, options.report);
  const counts = report.stages.reduce((a, x) => { a[x.status] = (a[x.status] || 0) + 1; return a; }, {});
  console.log(`AO agent E2E: ${counts.passed || 0} passed, ${counts.unobservable || 0} unobservable, ${counts.failed || 0} failed`); if (options.report) console.log(`Report: ${resolve(expandHome(options.report))}`); if (report.failure) { console.error(`Failed at ${report.failure.stage}: ${report.failure.reason}`); return 1; } return 0;
}

main().then((code) => { process.exitCode = code; }).catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
