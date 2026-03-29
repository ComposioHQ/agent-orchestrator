/**
 * Persistence layer for standalone terminals.
 * Standalone terminals are user-created tmux sessions that are not tied to AO sessions.
 * Stored in ~/.agent-orchestrator/standalone-terminals.json
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface StandaloneTerminal {
  id: string;
  tmuxName: string;
  label: string;
  createdAt: string;
}

interface StandaloneTerminalRegistry {
  terminals: StandaloneTerminal[];
}

function getRegistryPath(): string {
  return join(homedir(), ".agent-orchestrator", "standalone-terminals.json");
}

function ensureRegistryDir(): void {
  const dir = join(homedir(), ".agent-orchestrator");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function loadTerminals(): StandaloneTerminal[] {
  const path = getRegistryPath();
  if (!existsSync(path)) {
    return [];
  }
  try {
    const content = readFileSync(path, "utf-8");
    const registry = JSON.parse(content) as StandaloneTerminalRegistry;
    return registry.terminals ?? [];
  } catch {
    return [];
  }
}

export function saveTerminal(terminal: StandaloneTerminal): void {
  ensureRegistryDir();
  const path = getRegistryPath();
  const terminals = loadTerminals();
  const existingIndex = terminals.findIndex((t) => t.id === terminal.id);
  if (existingIndex >= 0) {
    terminals[existingIndex] = terminal;
  } else {
    terminals.push(terminal);
  }
  const registry: StandaloneTerminalRegistry = { terminals };
  writeFileSync(path, JSON.stringify(registry, null, 2), "utf-8");
}

export function removeTerminal(id: string): void {
  ensureRegistryDir();
  const path = getRegistryPath();
  const terminals = loadTerminals().filter((t) => t.id !== id);
  const registry: StandaloneTerminalRegistry = { terminals };
  writeFileSync(path, JSON.stringify(registry, null, 2), "utf-8");
}
