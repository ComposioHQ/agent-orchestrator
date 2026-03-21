/**
 * test-routing.ts — Smart routing complexity classifier smoke tests
 *
 * Tests classifyTaskComplexity() from @composio/ao-core against real Claude Haiku,
 * and validates the agent-local-llm plugin endpoint configuration is model-agnostic.
 *
 * Usage:
 *   Live (requires ANTHROPIC_API_KEY):
 *     npx tsx scripts/test-routing.ts
 *
 *   Mock (validates logic without API calls):
 *     npx tsx scripts/test-routing.ts --mock
 *
 * The script must be run from a worktree that has built @composio/ao-core dist files.
 * Run `pnpm build` first if needed.
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Resolve classifyTaskComplexity from the local workspace build
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));

// Try workspace package first, fall back to local dist path
let classifyTaskComplexity: (issueContext: string) => Promise<"simple" | "complex">;
try {
  // Resolves via pnpm workspace when built
  const core = await import("../packages/core/dist/session-manager.js");
  classifyTaskComplexity = core.classifyTaskComplexity;
} catch {
  throw new Error(
    "Could not import classifyTaskComplexity — run `pnpm build` in packages/core first.\n" +
      `Looking in: ${resolve(__dirname, "../packages/core/dist/session-manager.js")}`,
  );
}

// =============================================================================
// Test cases
// =============================================================================

interface TestCase {
  description: string;
  expected: "simple" | "complex";
}

const SIMPLE_TASKS: TestCase[] = [
  { description: "Fix typo in README.md", expected: "simple" },
  { description: "Update version number in package.json to 1.2.3", expected: "simple" },
  { description: "Change the default timeout config from 5000 to 10000", expected: "simple" },
  { description: "Add a missing semicolon in utils.ts", expected: "simple" },
];

const COMPLEX_TASKS: TestCase[] = [
  {
    description:
      "Implement a new plugin system for custom SCM providers with a full adapter interface",
    expected: "complex",
  },
  {
    description:
      "Debug why CI reactions are not firing after PR merge across lifecycle-manager and session-manager",
    expected: "complex",
  },
  {
    description: "Refactor the entire routing layer to support multi-project parallel execution",
    expected: "complex",
  },
  {
    description:
      "Add GitLab MR lifecycle support including webhook handling, CI polling, and review tracking",
    expected: "complex",
  },
];

// =============================================================================
// agent-local-llm endpoint reachability check (model-agnostic)
// =============================================================================

interface EndpointConfig {
  baseURL: string;
  model: string;
  label: string;
}

// Two different models to show the plugin is model-agnostic
const ENDPOINT_CONFIGS: EndpointConfig[] = [
  {
    baseURL: "http://localhost:11434/v1",
    model: "qwen3:8b",
    label: "Ollama / qwen3:8b",
  },
  {
    baseURL: "http://localhost:11434/v1",
    model: "deepseek-coder:latest",
    label: "Ollama / deepseek-coder:latest",
  },
];

async function checkEndpoint(baseURL: string): Promise<boolean> {
  try {
    const url = `${baseURL.replace(/\/$/, "")}/models`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    return res.ok;
  } catch {
    return false;
  }
}

async function getAvailableModels(baseURL: string): Promise<string[]> {
  try {
    const url = `${baseURL.replace(/\/$/, "")}/models`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: Array<{ id?: string }> };
    return (data.data ?? []).map((m) => m.id ?? "").filter(Boolean);
  } catch {
    return [];
  }
}

// =============================================================================
// Mock classifier (for --mock mode, no API key needed)
// =============================================================================

/**
 * Deterministic mock that mirrors classifyTaskComplexity's decision logic.
 * Simple heuristic: if the task mentions single-file/typo/version/config → simple.
 * Otherwise → complex.
 */
function mockClassify(task: string): "simple" | "complex" {
  const lower = task.toLowerCase();
  const simpleKeywords = [
    "typo",
    "fix typo",
    "update version",
    "version number",
    "missing semicolon",
    "default timeout",
    "config from",
  ];
  if (simpleKeywords.some((kw) => lower.includes(kw))) return "simple";
  return "complex";
}

// =============================================================================
// Runner
// =============================================================================

interface TestResult {
  task: string;
  expected: "simple" | "complex";
  actual: "simple" | "complex";
  pass: boolean;
}

async function runTests(
  cases: TestCase[],
  classify: (task: string) => Promise<"simple" | "complex">,
): Promise<TestResult[]> {
  const results: TestResult[] = [];
  for (const tc of cases) {
    const actual = await classify(tc.description);
    results.push({ task: tc.description, expected: tc.expected, actual, pass: actual === tc.expected });
  }
  return results;
}

function printResults(label: string, results: TestResult[]): void {
  console.log(`\n── ${label} ──`);
  for (const r of results) {
    const icon = r.pass ? "✓" : "✗";
    const status = r.pass ? "PASS" : `FAIL (got '${r.actual}', expected '${r.expected}')`;
    console.log(`  ${icon}  ${status}`);
    console.log(`       "${r.task}"`);
  }
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  const isMock = process.argv.includes("--mock");
  const mode = isMock ? "MOCK" : "LIVE";

  console.log(`=== Smart Routing: classifyTaskComplexity() tests [${mode}] ===\n`);

  // ── Step 1: agent-local-llm endpoint checks ──────────────────────────────
  console.log("── agent-local-llm endpoint checks (model-agnostic) ──");

  // Check unique endpoints first
  const endpointStatus = new Map<string, boolean>();
  for (const ep of ENDPOINT_CONFIGS) {
    if (!endpointStatus.has(ep.baseURL)) {
      const reachable = await checkEndpoint(ep.baseURL);
      endpointStatus.set(ep.baseURL, reachable);
      const icon = reachable ? "✓" : "⚠";
      const status = reachable ? "reachable" : "NOT reachable";
      console.log(`  ${icon}  ${ep.baseURL}  →  ${status}`);
    }
  }

  // List available models (if endpoint is up)
  for (const [baseURL, reachable] of endpointStatus) {
    if (reachable) {
      const models = await getAvailableModels(baseURL);
      if (models.length > 0) {
        console.log(`       Available models: ${models.join(", ")}`);
      }
    }
  }

  // Show each configured endpoint + model combo
  console.log("\n  Configured endpoint/model combinations:");
  for (const ep of ENDPOINT_CONFIGS) {
    const reachable = endpointStatus.get(ep.baseURL) ?? false;
    const modelStatus = reachable ? "endpoint reachable, model not validated" : "endpoint down";
    console.log(`    • ${ep.label}`);
    console.log(`      baseURL=${ep.baseURL}, model=${ep.model}`);
    console.log(`      status: ${modelStatus}`);
  }

  // ── Step 2: Classifier tests ──────────────────────────────────────────────
  if (isMock) {
    console.log("\n[Mock mode] Using deterministic classifier (no API calls)");
    const classify = async (task: string) => mockClassify(task);
    const simpleResults = await runTests(SIMPLE_TASKS, classify);
    const complexResults = await runTests(COMPLEX_TASKS, classify);
    printResults("Simple tasks (expect 'simple')", simpleResults);
    printResults("Complex tasks (expect 'complex')", complexResults);
    summarize([...simpleResults, ...complexResults]);
    return;
  }

  if (!process.env["ANTHROPIC_API_KEY"]) {
    console.warn(
      "\n⚠  ANTHROPIC_API_KEY not set — skipping live classifier tests.\n" +
        "   To run live: ANTHROPIC_API_KEY=sk-... npx tsx scripts/test-routing.ts\n" +
        "   To run mock: npx tsx scripts/test-routing.ts --mock",
    );
    process.exit(0);
  }

  console.log("\nRunning live classifier against Claude Haiku (claude-haiku-4-5-20251001)...");

  const classify = (task: string) => classifyTaskComplexity(task);
  const simpleResults = await runTests(SIMPLE_TASKS, classify);
  const complexResults = await runTests(COMPLEX_TASKS, classify);

  printResults("Simple tasks (expect 'simple')", simpleResults);
  printResults("Complex tasks (expect 'complex')", complexResults);

  summarize([...simpleResults, ...complexResults]);
}

function summarize(all: TestResult[]): void {
  const passed = all.filter((r) => r.pass).length;
  const failed = all.filter((r) => !r.pass).length;
  console.log(`\n=== Summary: ${passed}/${all.length} passed, ${failed} failed ===`);

  if (failed > 0) {
    console.log("\nFailed cases:");
    for (const r of all.filter((r) => !r.pass)) {
      console.log(`  • "${r.task}"`);
      console.log(`    Expected: ${r.expected}, got: ${r.actual}`);
    }
    console.log(
      "\nIf the live classifier misclassifies, check the prompt in:\n" +
        "  packages/core/src/session-manager.ts → classifyTaskComplexity()",
    );
    process.exit(1);
  }

  console.log("\n✓ All tests passed.");
}

main().catch((err: unknown) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
