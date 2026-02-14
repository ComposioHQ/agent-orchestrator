import { spawn, type ChildProcess } from "node:child_process";
import { request } from "node:http";

interface ServerHandle {
  baseUrl: string;
  stop: () => void;
}

function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request({ hostname: "127.0.0.1", port, path: "/", method: "HEAD", timeout: 2000 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

async function waitForServer(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await probePort(port)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Server did not start on port ${port} within ${timeoutMs}ms`);
}

export async function ensureServer(port: number): Promise<ServerHandle> {
  const baseUrl = `http://127.0.0.1:${port}`;

  if (await probePort(port)) {
    console.log(`Reusing existing server on port ${port}`);
    return { baseUrl, stop: () => {} };
  }

  console.log(`Starting dev server on port ${port}...`);
  const child: ChildProcess = spawn("npx", ["next", "dev", "--port", String(port)], {
    cwd: new URL("../../", import.meta.url).pathname,
    stdio: "pipe",
    env: { ...process.env, NODE_ENV: "development" },
  });

  child.stdout?.resume();
  child.stderr?.on("data", (chunk: Buffer) => {
    const line = chunk.toString().trim();
    if (line) console.log(`[next] ${line}`);
  });

  try {
    await waitForServer(port, 30_000);
  } catch (err) {
    child.kill("SIGTERM");
    throw err;
  }

  console.log(`Dev server ready on ${baseUrl}`);

  return {
    baseUrl,
    stop: () => {
      child.kill("SIGTERM");
    },
  };
}
