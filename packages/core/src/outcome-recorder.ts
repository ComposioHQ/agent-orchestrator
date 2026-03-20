import {
  appendFileSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { dirname } from "node:path";
import type { RecordedOutcome } from "./types.js";

export interface OutcomeRecorderDeps {
  storagePath: string;
}

export class OutcomeRecorder {
  private readonly storagePath: string;

  constructor(deps: OutcomeRecorderDeps) {
    this.storagePath = deps.storagePath;
  }

  record(outcome: RecordedOutcome): void {
    const dir = dirname(this.storagePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    appendFileSync(this.storagePath, JSON.stringify(outcome) + "\n", "utf-8");
  }

  query(filters: {
    trigger?: string;
    action?: string;
    projectId?: string;
    errorClass?: string;
  }): RecordedOutcome[] {
    const outcomes = this.readAll();
    return outcomes.filter((o) => {
      if (filters.trigger !== undefined && o.trigger !== filters.trigger) return false;
      if (filters.action !== undefined && o.action !== filters.action) return false;
      if (filters.projectId !== undefined && o.projectId !== filters.projectId) return false;
      if (filters.errorClass !== undefined && o.errorClass !== filters.errorClass) return false;
      return true;
    });
  }

  getWinRate(strategy: string, action: string, errorClass?: string): number {
    const matching = this.readAll().filter(
      (o) =>
        o.strategy === strategy &&
        o.action === action &&
        (errorClass === undefined || o.errorClass === errorClass),
    );
    if (matching.length === 0) return 0;
    const wins = matching.filter((o) => o.success).length;
    return wins / matching.length;
  }

  getTopStrategies(
    strategy: string,
    limit?: number,
    errorClass?: string,
  ): Array<{ action: string; winRate: number; count: number }> {
    const outcomes = this.readAll().filter(
      (o) =>
        o.strategy === strategy &&
        (errorClass === undefined || o.errorClass === errorClass),
    );
    const byAction = new Map<string, { wins: number; total: number }>();

    for (const o of outcomes) {
      const entry = byAction.get(o.action) ?? { wins: 0, total: 0 };
      entry.total++;
      if (o.success) entry.wins++;
      byAction.set(o.action, entry);
    }

    const strategies = Array.from(byAction.entries())
      .map(([action, { wins, total }]) => ({
        action,
        winRate: total > 0 ? wins / total : 0,
        count: total,
      }))
      .sort((a, b) => b.winRate - a.winRate || b.count - a.count);

    return limit !== undefined ? strategies.slice(0, limit) : strategies;
  }

  clear(): void {
    const dir = dirname(this.storagePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.storagePath, "", "utf-8");
  }

  private readAll(): RecordedOutcome[] {
    if (!existsSync(this.storagePath)) return [];
    const content = readFileSync(this.storagePath, "utf-8");
    const outcomes: RecordedOutcome[] = [];
    for (const line of content.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        outcomes.push(JSON.parse(line) as RecordedOutcome);
      } catch {
        // Skip malformed JSONL lines
      }
    }
    return outcomes;
  }
}
