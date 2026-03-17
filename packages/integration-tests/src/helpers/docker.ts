import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const TIMEOUT = 30_000;

export async function isDockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync("docker", ["info"], { timeout: TIMEOUT });
    return true;
  } catch {
    return false;
  }
}

export async function killContainersByPrefix(prefix: string): Promise<void> {
  try {
    const { stdout } = await execFileAsync("docker", ["ps", "-a", "--format", "{{.Names}}"], {
      timeout: TIMEOUT,
    });
    const containers = stdout
      .trim()
      .split("\n")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0 && entry.startsWith(prefix));

    for (const name of containers) {
      try {
        await execFileAsync("docker", ["rm", "-f", name], { timeout: TIMEOUT });
      } catch {
        // best effort
      }
    }
  } catch {
    // Docker unavailable or no containers
  }
}
