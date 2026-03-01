import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "@playwright/test";

interface ScreenshotOptions {
  width?: number;
  height?: number;
}

interface PageSpec {
  path: string;
  name: string;
}

function pathToName(path: string): string {
  if (path === "/") return "dashboard";
  return path.replace(/^\//, "").replace(/\//g, "-");
}

const DEFAULT_PAGES: PageSpec[] = [
  { path: "/", name: "dashboard" },
  { path: "/sessions/backend-3", name: "session-detail" },
];

export async function captureScreenshots(
  baseUrl: string,
  extraPaths: string[],
  options: ScreenshotOptions = {},
): Promise<string[]> {
  const { width = 1280, height = 900 } = options;

  const screenshotDir = join(new URL("../../", import.meta.url).pathname, "screenshots");
  await mkdir(screenshotDir, { recursive: true });

  const pages: PageSpec[] =
    extraPaths.length > 0
      ? extraPaths.map((p) => ({ path: p, name: pathToName(p) }))
      : DEFAULT_PAGES;

  const browser = await chromium.launch({ headless: true });
  const savedPaths: string[] = [];

  try {
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();

    for (const spec of pages) {
      const url = `${baseUrl}${spec.path}`;
      console.log(`Navigating to ${url}`);
      await page.goto(url, { waitUntil: "networkidle" });
      // Extra delay for React hydration
      await page.waitForTimeout(1000);

      const filePath = join(screenshotDir, `${spec.name}.png`);
      await page.screenshot({ path: filePath, fullPage: true });
      savedPaths.push(filePath);
      console.log(`Saved ${filePath}`);
    }
  } finally {
    await browser.close();
  }

  return savedPaths;
}
