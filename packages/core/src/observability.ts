import {
  mkdirSync,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { OrchestratorConfig, SessionId } from "./types.js";
import { getObservabilityBaseDir } from "./paths.js";

export type ObservabilityLevel = "debug" | "info" | "warn" | "error";
export type ObservabilityOutcome = "success" | "failure";
export type ObservabilityHealthStatus = "ok" | "warn" | "error";
export type ObservabilityMetricName =
  | "api_request"
  | "claim_pr"
  | "cleanup"
  | "graphql_batch"
  | "kill"
  | "lifecycle_poll"
  | "restore"
  | "send"
  | "spawn"
  | "sse_connect"
  | "sse_disconnect"
  | "sse_snapshot"
  | "websocket_connect"
  | "websocket_disconnect"
  | "websocket_error";

export interface ObservabilityMetricCounter {
  total: number;
  success: number;
  failure: number;
  lastAt?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastFailureReason?: string;
}

export interface ObservabilityTraceRecord {
  id: string;
  timestamp: string;
  component: string;
  operation: string;
  outcome: ObservabilityOutcome;
  correlationId: string;
  projectId?: string;
  sessionId?: SessionId;
  path?: string;
  reason?: string;
  durationMs?: number;
  data?: Record<string, unknown>;
}

export interface ObservabilitySessionStatus {
  sessionId: SessionId;
  projectId?: string;
  correlationId: string;
  operation: string;
  outcome: ObservabilityOutcome;
  updatedAt: string;
  reason?: string;
}

export interface ObservabilityHealthSurface {
  surface: string;
  status: ObservabilityHealthStatus;
  updatedAt: string;
  component: string;
  projectId?: string;
  correlationId?: string;
  reason?: string;
  details?: Record<string, unknown>;
}

export interface ObservabilityProjectSnapshot {
  projectId: string;
  updatedAt: string;
  metrics: Record<string, ObservabilityMetricCounter>;
  health: Record<string, ObservabilityHealthSurface>;
  recentTraces: ObservabilityTraceRecord[];
  sessions: Record<string, ObservabilitySessionStatus>;
}

export interface ObservabilitySummary {
  generatedAt: string;
  overallStatus: ObservabilityHealthStatus;
  projects: Record<string, ObservabilityProjectSnapshot>;
}

interface ProcessObservabilitySnapshot {
  version: 1;
  component: string;
  pid: number;
  updatedAt: string;
  metrics: Record<string, ObservabilityMetricCounter>;
  traces: ObservabilityTraceRecord[];
  sessions: Record<string, ObservabilitySessionStatus>;
  health: Record<string, ObservabilityHealthSurface>;
}

export interface RecordOperationInput {
  metric: ObservabilityMetricName;
  operation?: string;
  outcome: ObservabilityOutcome;
  correlationId: string;
  projectId?: string;
  sessionId?: SessionId;
  reason?: string;
  durationMs?: number;
  path?: string;
  data?: Record<string, unknown>;
  level?: ObservabilityLevel;
}

export interface SetHealthInput {
  surface: string;
  status: ObservabilityHealthStatus;
  projectId?: string;
  correlationId?: string;
  reason?: string;
  details?: Record<string, unknown>;
}

export interface ProjectObserver {
  readonly component: string;
  recordOperation(input: RecordOperationInput): void;
  setHealth(input: SetHealthInput): void;
}

const TRACE_LIMIT = 80;
const SESSION_LIMIT = 200;
const LEVEL_ORDER: Record<ObservabilityLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function nowIso(): string {
  return new Date().toISOString();
}

function sanitizeComponent(component: string): string {
  return component.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "component";
}

function getLogLevel(): ObservabilityLevel {
  const raw = process.env["AO_LOG_LEVEL"]?.trim().toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return "warn";
}

function shouldLog(level: ObservabilityLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[getLogLevel()];
}

function emitStructuredLog(entry: Record<string, unknown>, level: ObservabilityLevel): void {
  if (!shouldLog(level)) return;
  process.stderr.write(`${JSON.stringify({ ...entry, level })}\n`);
}

function atomicWriteJson(filePath: string, payload: unknown): void {
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  renameSync(tmpPath, filePath);
}

function getObservabilityDir(config: OrchestratorConfig): string {
  const dir = join(getObservabilityBaseDir(config.configPath), "processes");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function getSnapshotPath(config: OrchestratorConfig, component: string): string {
  return join(getObservabilityDir(config), `${sanitizeComponent(component)}-${process.pid}.json`);
}

function readSnapshot(filePath: string, component: string): ProcessObservabilitySnapshot {
  if (!existsSync(filePath)) {
    return {
      version: 1,
      component,
      pid: process.pid,
      updatedAt: nowIso(),
      metrics: {},
      traces: [],
      sessions: {},
      health: {},
    };
  }

  try {
    const parsed = JSON.parse(
      readFileSync(filePath, "utf-8"),
    ) as Partial<ProcessObservabilitySnapshot>;
    return {
      version: 1,
      component,
      pid: process.pid,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : nowIso(),
      metrics: parsed.metrics && typeof parsed.metrics === "object" ? parsed.metrics : {},
      traces: Array.isArray(parsed.traces) ? parsed.traces : [],
      sessions: parsed.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {},
      health: parsed.health && typeof parsed.health === "object" ? parsed.health : {},
    };
  } catch {
    return {
      version: 1,
      component,
      pid: process.pid,
      updatedAt: nowIso(),
      metrics: {},
      traces: [],
      sessions: {},
      health: {},
    };
  }
}

function writeSnapshot(config: OrchestratorConfig, snapshot: ProcessObservabilitySnapshot): void {
  const filePath = getSnapshotPath(config, snapshot.component);
  snapshot.updatedAt = nowIso();
  atomicWriteJson(filePath, snapshot);
}

function compareIsoDesc(a: string, b: string): number {
  return b.localeCompare(a);
}

function mergeCounter(
  target: ObservabilityMetricCounter | undefined,
  source: ObservabilityMetricCounter,
): ObservabilityMetricCounter {
  const merged: ObservabilityMetricCounter = {
    total: (target?.total ?? 0) + (source.total ?? 0),
    success: (target?.success ?? 0) + (source.success ?? 0),
    failure: (target?.failure ?? 0) + (source.failure ?? 0),
    lastAt: target?.lastAt,
    lastSuccessAt: target?.lastSuccessAt,
    lastFailureAt: target?.lastFailureAt,
    lastFailureReason: target?.lastFailureReason,
  };

  if (source.lastAt && (!merged.lastAt || source.lastAt > merged.lastAt)) {
    merged.lastAt = source.lastAt;
  }
  if (
    source.lastSuccessAt &&
    (!merged.lastSuccessAt || source.lastSuccessAt > merged.lastSuccessAt)
  ) {
    merged.lastSuccessAt = source.lastSuccessAt;
  }
  if (
    source.lastFailureAt &&
    (!merged.lastFailureAt || source.lastFailureAt > merged.lastFailureAt)
  ) {
    merged.lastFailureAt = source.lastFailureAt;
    merged.lastFailureReason = source.lastFailureReason;
  }

  return merged;
}

function healthSeverity(status: ObservabilityHealthStatus): number {
  switch (status) {
    case "error":
      return 3;
    case "warn":
      return 2;
    default:
      return 1;
  }
}

function metricBucketKey(metric: ObservabilityMetricName, projectId?: string): string {
  return `${projectId ?? "unknown"}::${metric}`;
}

function parseMetricBucketKey(bucketKey: string): { projectId?: string; metric: string } {
  const separatorIndex = bucketKey.indexOf("::");
  if (separatorIndex === -1) {
    return { metric: bucketKey };
  }
  const projectId = bucketKey.slice(0, separatorIndex);
  return {
    projectId: projectId === "unknown" ? undefined : projectId,
    metric: bucketKey.slice(separatorIndex + 2),
  };
}

export function createCorrelationId(prefix = "ao"): string {
  return `${prefix}-${randomUUID()}`;
}

export function createProjectObserver(
  config: OrchestratorConfig,
  component: string,
): ProjectObserver {
  const normalizedComponent = sanitizeComponent(component);

  function updateSnapshot(
    updater: (snapshot: ProcessObservabilitySnapshot) => void,
    logEntry?: { level: ObservabilityLevel; payload: Record<string, unknown> },
  ): void {
    try {
      const filePath = getSnapshotPath(config, normalizedComponent);
      const snapshot = readSnapshot(filePath, normalizedComponent);
      updater(snapshot);
      writeSnapshot(config, snapshot);
      if (logEntry) {
        emitStructuredLog(logEntry.payload, logEntry.level);
      }
    } catch (error) {
      emitStructuredLog(
        {
          source: "ao-observability",
          component: normalizedComponent,
          outcome: "failure",
          operation: "observability.write",
          reason: error instanceof Error ? error.message : String(error),
        },
        "error",
      );
    }
  }

  return {
    component: normalizedComponent,
    recordOperation(input) {
      const timestamp = nowIso();
      const operation = input.operation ?? input.metric;
      const level = input.level ?? (input.outcome === "failure" ? "error" : "info");
      const trace: ObservabilityTraceRecord = {
        id: randomUUID(),
        timestamp,
        component: normalizedComponent,
        operation,
        outcome: input.outcome,
        correlationId: input.correlationId,
        projectId: input.projectId,
        sessionId: input.sessionId,
        path: input.path,
        reason: input.reason,
        durationMs: input.durationMs,
        data: input.data,
      };

      updateSnapshot(
        (snapshot) => {
          const bucketKey = metricBucketKey(input.metric, input.projectId);
          const currentCounter = snapshot.metrics[bucketKey] ?? {
            total: 0,
            success: 0,
            failure: 0,
          };
          currentCounter.total += 1;
          currentCounter.lastAt = timestamp;
          if (input.outcome === "success") {
            currentCounter.success += 1;
            currentCounter.lastSuccessAt = timestamp;
          } else {
            currentCounter.failure += 1;
            currentCounter.lastFailureAt = timestamp;
            currentCounter.lastFailureReason = input.reason;
          }
          snapshot.metrics[bucketKey] = currentCounter;

          snapshot.traces = [trace, ...snapshot.traces]
            .sort((a, b) => compareIsoDesc(a.timestamp, b.timestamp))
            .slice(0, TRACE_LIMIT);

          if (input.sessionId) {
            snapshot.sessions[input.sessionId] = {
              sessionId: input.sessionId,
              projectId: input.projectId,
              correlationId: input.correlationId,
              operation,
              outcome: input.outcome,
              updatedAt: timestamp,
              reason: input.reason,
            };

            const sessionEntries = Object.entries(snapshot.sessions).sort(([, a], [, b]) =>
              compareIsoDesc(a.updatedAt, b.updatedAt),
            );
            snapshot.sessions = Object.fromEntries(sessionEntries.slice(0, SESSION_LIMIT));
          }
        },
        {
          level,
          payload: {
            source: "ao-observability",
            component: normalizedComponent,
            metric: input.metric,
            operation,
            outcome: input.outcome,
            correlationId: input.correlationId,
            projectId: input.projectId,
            sessionId: input.sessionId,
            reason: input.reason,
            durationMs: input.durationMs,
            path: input.path,
            data: input.data,
          },
        },
      );
    },

    setHealth(input) {
      const updatedAt = nowIso();
      updateSnapshot(
        (snapshot) => {
          snapshot.health[input.surface] = {
            surface: input.surface,
            status: input.status,
            updatedAt,
            component: normalizedComponent,
            projectId: input.projectId,
            correlationId: input.correlationId,
            reason: input.reason,
            details: input.details,
          };
        },
        {
          level: input.status === "error" ? "error" : input.status === "warn" ? "warn" : "info",
          payload: {
            source: "ao-observability",
            component: normalizedComponent,
            surface: input.surface,
            status: input.status,
            projectId: input.projectId,
            correlationId: input.correlationId,
            reason: input.reason,
            details: input.details,
          },
        },
      );
    },
  };
}

export function readObservabilitySummary(config: OrchestratorConfig): ObservabilitySummary {
  const dir = getObservabilityDir(config);
  const projects: Record<string, ObservabilityProjectSnapshot> = {};

  for (const fileName of readdirSync(dir)) {
    if (!fileName.endsWith(".json")) continue;
    const filePath = join(dir, fileName);

    let snapshot: ProcessObservabilitySnapshot;
    try {
      snapshot = JSON.parse(readFileSync(filePath, "utf-8")) as ProcessObservabilitySnapshot;
    } catch {
      continue;
    }

    if (!snapshot || typeof snapshot !== "object") continue;

    for (const [bucketKey, counter] of Object.entries(snapshot.metrics ?? {})) {
      const { projectId, metric } = parseMetricBucketKey(bucketKey);
      if (!projectId) continue;
      const project =
        projects[projectId] ??
        (projects[projectId] = {
          projectId,
          updatedAt: snapshot.updatedAt,
          metrics: {},
          health: {},
          recentTraces: [],
          sessions: {},
        });
      project.metrics[metric] = mergeCounter(project.metrics[metric], counter);
      if (snapshot.updatedAt > project.updatedAt) {
        project.updatedAt = snapshot.updatedAt;
      }
    }

    for (const trace of snapshot.traces ?? []) {
      if (!trace.projectId) continue;
      const project =
        projects[trace.projectId] ??
        (projects[trace.projectId] = {
          projectId: trace.projectId,
          updatedAt: trace.timestamp,
          metrics: {},
          health: {},
          recentTraces: [],
          sessions: {},
        });
      project.recentTraces.push(trace);
      if (trace.timestamp > project.updatedAt) {
        project.updatedAt = trace.timestamp;
      }
    }

    for (const health of Object.values(snapshot.health ?? {})) {
      const projectId = health.projectId;
      if (!projectId) continue;
      const project =
        projects[projectId] ??
        (projects[projectId] = {
          projectId,
          updatedAt: health.updatedAt,
          metrics: {},
          health: {},
          recentTraces: [],
          sessions: {},
        });
      const existing = project.health[health.surface];
      if (!existing || health.updatedAt >= existing.updatedAt) {
        project.health[health.surface] = health;
      }
      if (health.updatedAt > project.updatedAt) {
        project.updatedAt = health.updatedAt;
      }
    }

    for (const session of Object.values(snapshot.sessions ?? {})) {
      if (!session.projectId) continue;
      const project =
        projects[session.projectId] ??
        (projects[session.projectId] = {
          projectId: session.projectId,
          updatedAt: session.updatedAt,
          metrics: {},
          health: {},
          recentTraces: [],
          sessions: {},
        });
      const existing = project.sessions[session.sessionId];
      if (!existing || session.updatedAt >= existing.updatedAt) {
        project.sessions[session.sessionId] = session;
      }
      if (session.updatedAt > project.updatedAt) {
        project.updatedAt = session.updatedAt;
      }
    }
  }

  let overallStatus: ObservabilityHealthStatus = "ok";
  for (const project of Object.values(projects)) {
    project.recentTraces = project.recentTraces
      .sort((a, b) => compareIsoDesc(a.timestamp, b.timestamp))
      .slice(0, TRACE_LIMIT);
    for (const health of Object.values(project.health)) {
      if (healthSeverity(health.status) > healthSeverity(overallStatus)) {
        overallStatus = health.status;
      }
    }
  }

  return {
    generatedAt: nowIso(),
    overallStatus,
    projects,
  };
}
