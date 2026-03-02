import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const TIMEOUT = 30_000;

export async function exportOpencodeSession(sessionId: string, cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("opencode", ["export", sessionId], {
    timeout: 120_000,
    cwd,
  });
  return stdout;
}

const CHEAP_MODEL_PREFERENCE = [
  "opencode/gpt-5-nano",
  "opencode/minimax-m2.5-free",
  "opencode/trinity-large-preview-free",
  "opencode/claude-3-5-haiku",
] as const;

export async function isOpencodeAvailable(): Promise<boolean> {
  try {
    await execFileAsync("opencode", ["--version"], { timeout: TIMEOUT });
    return true;
  } catch {
    return false;
  }
}

export async function listOpencodeModels(): Promise<string[]> {
  const { stdout } = await execFileAsync("opencode", ["models", "--verbose"], {
    timeout: 120_000,
  });

  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[a-z0-9][a-z0-9-]*\/[A-Za-z0-9._:-]+$/.test(line));
}

export async function pickCheapModel(): Promise<string | null> {
  if (process.env.AO_TEST_NANO_MODEL) {
    return process.env.AO_TEST_NANO_MODEL;
  }

  const models = await listOpencodeModels();
  for (const candidate of CHEAP_MODEL_PREFERENCE) {
    if (models.includes(candidate)) return candidate;
  }

  return models[0] ?? null;
}
