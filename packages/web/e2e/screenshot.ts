import { ensureServer } from "./lib/server.js";
import { captureScreenshots } from "./lib/browser.js";

function parseArgs(argv: string[]): { port: number; width: number; height: number; paths: string[] } {
  const args = argv.slice(2);
  let port = 3333;
  let width = 1280;
  let height = 900;
  const paths: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--port" && args[i + 1]) {
      const n = Number(args[++i]);
      if (Number.isNaN(n)) throw new Error(`Invalid --port value: ${args[i]}`);
      port = n;
    } else if (arg === "--width" && args[i + 1]) {
      const n = Number(args[++i]);
      if (Number.isNaN(n)) throw new Error(`Invalid --width value: ${args[i]}`);
      width = n;
    } else if (arg === "--height" && args[i + 1]) {
      const n = Number(args[++i]);
      if (Number.isNaN(n)) throw new Error(`Invalid --height value: ${args[i]}`);
      height = n;
    } else if (arg?.startsWith("/")) {
      paths.push(arg);
    }
  }

  return { port, width, height, paths };
}

async function main(): Promise<void> {
  const { port, width, height, paths } = parseArgs(process.argv);

  const server = await ensureServer(port);

  try {
    const saved = await captureScreenshots(server.baseUrl, paths, { width, height });
    console.log(`\nDone — ${saved.length} screenshot(s) saved.`);
  } finally {
    server.stop();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
