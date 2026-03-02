import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function exportOpencodeSession(sessionId: string, cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("opencode", ["export", sessionId], {
    timeout: 120_000,
    cwd,
  });
  return stdout;
}
