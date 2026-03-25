import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { SpawnOptions } from "node:child_process";

export const DEFAULT_ACPX_AGENT = "pi";
export const DEFAULT_PROMPT_FLUSH_DELAY_MS = 150;
export const SUPPORTED_ACPX_AGENTS = [DEFAULT_ACPX_AGENT, "codex", "claude", "gemini"] as const;

export type SupportedAcpxAgent = (typeof SUPPORTED_ACPX_AGENTS)[number];

export interface BridgeSpawn {
  (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ): ChildProcess;
}

export interface AcpxBridgeOptions {
  acpxPath?: string;
  acpxAgent?: string;
  cwd?: string;
  systemPrompt?: string;
  flushDelayMs?: number;
  spawnImpl?: BridgeSpawn;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

export function normalizeAcpxAgent(agent: string | undefined): SupportedAcpxAgent {
  if (!agent) {
    return DEFAULT_ACPX_AGENT;
  }

  if ((SUPPORTED_ACPX_AGENTS as readonly string[]).includes(agent)) {
    return agent as SupportedAcpxAgent;
  }

  throw new Error(`Unsupported acpx agent: ${agent}`);
}

export function readSystemPrompt(options: {
  systemPrompt?: string;
  systemPromptFile?: string;
}): string | undefined {
  if (options.systemPromptFile) {
    return readFileSync(options.systemPromptFile, "utf-8");
  }
  return options.systemPrompt;
}

export function composePrompt(prompt: string, systemPrompt?: string): string {
  const trimmedPrompt = prompt.replace(/\r/g, "").replace(/\n+$/, "");
  if (!systemPrompt || systemPrompt.trim().length === 0) {
    return trimmedPrompt;
  }

  const trimmedSystemPrompt = systemPrompt.replace(/\r/g, "").trimEnd();
  if (trimmedPrompt.length === 0) {
    return trimmedSystemPrompt;
  }

  return `${trimmedSystemPrompt}\n\n${trimmedPrompt}`;
}

export function buildEnsureSessionArgs(options: {
  acpxAgent?: string;
}): string[] {
  return [normalizeAcpxAgent(options.acpxAgent), "sessions", "ensure"];
}

export function buildPromptArgs(options: {
  acpxAgent?: string;
  prompt: string;
}): string[] {
  return [normalizeAcpxAgent(options.acpxAgent), "prompt", options.prompt];
}

export class AcpxBridge {
  private readonly acpxPath: string;
  private readonly acpxAgent: SupportedAcpxAgent;
  private readonly cwd: string;
  private readonly systemPrompt?: string;
  private readonly flushDelayMs: number;
  private readonly spawnImpl: BridgeSpawn;
  private readonly stdout: NodeJS.WritableStream;
  private readonly stderr: NodeJS.WritableStream;

  private bufferedInput = "";
  private flushTimer: NodeJS.Timeout | null = null;
  private queue: string[] = [];
  private dispatching = false;
  private idleWaiters: Array<() => void> = [];

  constructor(options: AcpxBridgeOptions = {}) {
    this.acpxPath = options.acpxPath ?? "acpx";
    this.acpxAgent = normalizeAcpxAgent(options.acpxAgent);
    this.cwd = options.cwd ?? process.cwd();
    this.systemPrompt = options.systemPrompt;
    this.flushDelayMs = options.flushDelayMs ?? DEFAULT_PROMPT_FLUSH_DELAY_MS;
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.stdout = options.stdout ?? process.stdout;
    this.stderr = options.stderr ?? process.stderr;
  }

  acceptInput(chunk: Buffer | string): void {
    this.bufferedInput += chunk.toString();
    this.scheduleFlush();
  }

  flushBufferedPrompt(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    const prompt = this.bufferedInput.replace(/\r/g, "").replace(/\n+$/, "");
    this.bufferedInput = "";
    if (!prompt.trim()) {
      return;
    }

    this.queuePrompt(prompt);
  }

  async drain(): Promise<void> {
    this.flushBufferedPrompt();
    if (!this.dispatching && this.queue.length === 0) {
      return;
    }

    await new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  private scheduleFlush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushBufferedPrompt();
    }, this.flushDelayMs);
  }

  private queuePrompt(prompt: string): void {
    this.queue.push(prompt);
    if (!this.dispatching) {
      void this.processQueue();
    }
  }

  private async processQueue(): Promise<void> {
    this.dispatching = true;
    try {
      while (this.queue.length > 0) {
        const prompt = this.queue.shift();
        if (!prompt) continue;
        await this.dispatchPrompt(prompt);
      }
    } finally {
      this.dispatching = false;
      if (this.queue.length === 0) {
        this.notifyIdle();
      }
    }
  }

  private notifyIdle(): void {
    if (this.dispatching || this.queue.length > 0) {
      return;
    }

    for (const waiter of this.idleWaiters.splice(0)) {
      waiter();
    }
  }

  private async dispatchPrompt(prompt: string): Promise<void> {
    const ensured = await this.runAcpxCommand(buildEnsureSessionArgs({ acpxAgent: this.acpxAgent }));
    if (!ensured) {
      return;
    }

    const composedPrompt = composePrompt(prompt, this.systemPrompt);
    await this.runAcpxCommand(buildPromptArgs({ acpxAgent: this.acpxAgent, prompt: composedPrompt }));
  }

  private runAcpxCommand(args: string[]): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const child = this.spawnImpl(this.acpxPath, args, {
        cwd: this.cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });

      child.stdout?.on("data", (chunk) => {
        this.stdout.write(chunk);
      });
      child.stderr?.on("data", (chunk) => {
        this.stderr.write(chunk);
      });

      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        this.stderr.write(`[acpx bridge] failed to start acpx: ${error.message}\n`);
        resolve(false);
      });

      child.once("close", (code, signal) => {
        if (settled) return;
        settled = true;
        if (code !== 0) {
          const reason = signal ? `signal ${signal}` : `exit code ${String(code)}`;
          this.stderr.write(`[acpx bridge] acpx ${this.acpxAgent} failed with ${reason}\n`);
          resolve(false);
          return;
        }
        resolve(true);
      });
    });
  }
}

function parseCliArgs(argv: readonly string[]): {
  acpxPath?: string;
  acpxAgent?: string;
  cwd?: string;
  systemPrompt?: string;
  systemPromptFile?: string;
  flushDelayMs?: number;
} {
  const parsed: {
    acpxPath?: string;
    acpxAgent?: string;
    cwd?: string;
    systemPrompt?: string;
    systemPromptFile?: string;
    flushDelayMs?: number;
  } = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--acpx-path") {
      const next = argv[index + 1];
      if (next == null) {
        throw new Error(`Missing value for ${arg}`);
      }
      parsed.acpxPath = next;
      index += 1;
      continue;
    }

    if (arg === "--agent") {
      const next = argv[index + 1];
      if (next == null) {
        throw new Error(`Missing value for ${arg}`);
      }
      parsed.acpxAgent = next;
      index += 1;
      continue;
    }

    if (arg === "--cwd") {
      const next = argv[index + 1];
      if (next == null) {
        throw new Error(`Missing value for ${arg}`);
      }
      parsed.cwd = next;
      index += 1;
      continue;
    }

    if (arg === "--system-prompt") {
      const next = argv[index + 1];
      if (next == null) {
        throw new Error(`Missing value for ${arg}`);
      }
      parsed.systemPrompt = next;
      index += 1;
      continue;
    }

    if (arg === "--system-prompt-file") {
      const next = argv[index + 1];
      if (next == null) {
        throw new Error(`Missing value for ${arg}`);
      }
      parsed.systemPromptFile = next;
      index += 1;
      continue;
    }

    if (arg === "--flush-delay-ms") {
      const next = argv[index + 1];
      if (next == null) {
        throw new Error(`Missing value for ${arg}`);
      }
      parsed.flushDelayMs = Number(next);
      index += 1;
      continue;
    }
  }

  return parsed;
}

export async function runBridgeCli(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parseCliArgs(argv);
  const systemPrompt = readSystemPrompt({
    systemPrompt: parsed.systemPrompt,
    systemPromptFile: parsed.systemPromptFile,
  });
  const bridge = new AcpxBridge({
    acpxPath: parsed.acpxPath,
    acpxAgent: parsed.acpxAgent,
    cwd: parsed.cwd,
    systemPrompt,
    flushDelayMs: parsed.flushDelayMs,
  });

  process.stdin.on("data", (chunk) => {
    bridge.acceptInput(chunk);
  });

  process.stdin.on("end", () => {
    void bridge.drain().then(() => {
      process.exitCode = 0;
    });
  });

  process.stdin.resume();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runBridgeCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[acpx bridge] ${message}\n`);
    process.exitCode = 1;
  });
}
