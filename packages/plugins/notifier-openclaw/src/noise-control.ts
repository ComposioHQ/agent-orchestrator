import type { EventPriority, OrchestratorEvent } from "@composio/ao-core";

export interface NoiseControlOptions {
  debounceWindowMs?: number;
  batchWindowMs?: number;
  batchTriggerCount?: number;
  batchSessionKey?: string;
  senderName?: string;
  wakeMode?: "now" | "next-heartbeat";
  deliver?: boolean;
  onBatchReady?: (payload: OpenClawWebhookPayload) => void | Promise<void>;
}

export interface OpenClawWebhookPayload {
  message: string;
  name?: string;
  sessionKey?: string;
  wakeMode?: "now" | "next-heartbeat";
  deliver?: boolean;
}

interface PendingBatch {
  events: OrchestratorEvent[];
  timer: ReturnType<typeof setTimeout>;
}

interface BurstWindow {
  recent: Array<{ ts: number; sessionId: string }>;
  activeBatch: PendingBatch | null;
}

function reasonKey(event: OrchestratorEvent): string {
  const reason =
    typeof event.data["reason"] === "string"
      ? event.data["reason"]
      : typeof event.data["action"] === "string"
        ? event.data["action"]
        : "na";
  return `${event.sessionId}|${event.type}|${reason}`;
}

function summarizePriority(events: OrchestratorEvent[]): EventPriority {
  const priorities: EventPriority[] = ["urgent", "action", "warning", "info"];
  for (const p of priorities) {
    if (events.some((event) => event.priority === p)) return p;
  }
  return "info";
}

function summaryTag(priority: EventPriority): string {
  return `[AO ${priority.toUpperCase()}]`;
}

function buildBatchSummary(events: OrchestratorEvent[]): string {
  const sessionSet = new Set(events.map((e) => e.sessionId));
  const reasonCounts = new Map<string, number>();

  for (const event of events) {
    const reason =
      typeof event.data["reason"] === "string" ? event.data["reason"] : event.type;
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  }

  const reasonSummary = [...reasonCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${reason}:${count}`)
    .join(",");

  const ids = [...sessionSet].sort().join(",");
  return `${summaryTag(summarizePriority(events))} batched_escalations count=${events.length} sessions=${sessionSet.size} ids=${ids} reasons=${reasonSummary}`;
}

export class EscalationNoiseController {
  private readonly debounceWindowMs: number;
  private readonly batchWindowMs: number;
  private readonly batchTriggerCount: number;
  private readonly batchSessionKey: string;
  private readonly senderName: string;
  private readonly wakeMode: "now" | "next-heartbeat";
  private readonly deliver: boolean;
  private readonly onBatchReady?: (payload: OpenClawWebhookPayload) => void | Promise<void>;
  private readonly debouncedAt = new Map<string, number>();
  private readonly burstState: BurstWindow = { recent: [], activeBatch: null };

  constructor(options?: NoiseControlOptions) {
    this.debounceWindowMs = options?.debounceWindowMs ?? 90_000;
    this.batchWindowMs = options?.batchWindowMs ?? 20_000;
    this.batchTriggerCount = options?.batchTriggerCount ?? 3;
    this.batchSessionKey = options?.batchSessionKey ?? "hook:ao:ops";
    this.senderName = options?.senderName ?? "AO";
    this.wakeMode = options?.wakeMode ?? "now";
    this.deliver = options?.deliver ?? true;
    this.onBatchReady = options?.onBatchReady;
  }

  evaluateEvent(event: OrchestratorEvent): "send" | "debounced" | "batched" {
    const now = Date.now();
    const key = reasonKey(event);
    const last = this.debouncedAt.get(key);
    if (last && now - last < this.debounceWindowMs) {
      return "debounced";
    }
    this.debouncedAt.set(key, now);

    this.burstState.recent = this.burstState.recent.filter((r) => now - r.ts <= this.batchWindowMs);
    this.burstState.recent.push({ ts: now, sessionId: event.sessionId });

    if (this.burstState.activeBatch) {
      this.burstState.activeBatch.events.push(event);
      return "batched";
    }

    const uniqueSessions = new Set(this.burstState.recent.map((r) => r.sessionId));
    if (this.burstState.recent.length >= this.batchTriggerCount && uniqueSessions.size >= 2) {
      this.startBatch(event);
      return "batched";
    }

    return "send";
  }

  private startBatch(firstEvent: OrchestratorEvent): void {
    const timer = setTimeout(() => {
      this.flushAndNotify().catch((error) => {
        console.error("[notifier-openclaw] Failed to flush escalation batch:", error);
      });
    }, this.batchWindowMs);

    this.burstState.activeBatch = {
      events: [firstEvent],
      timer,
    };
  }

  private async flushAndNotify(): Promise<void> {
    const payload = this.flushBatch();
    if (!payload || !this.onBatchReady) return;
    await this.onBatchReady(payload);
  }

  flushBatch(): OpenClawWebhookPayload | null {
    const pending = this.burstState.activeBatch;
    if (!pending) return null;
    clearTimeout(pending.timer);
    this.burstState.activeBatch = null;
    this.burstState.recent = [];

    if (pending.events.length === 0) return null;

    return {
      message: buildBatchSummary(pending.events),
      name: this.senderName,
      sessionKey: this.batchSessionKey,
      wakeMode: this.wakeMode,
      deliver: this.deliver,
    };
  }
}
