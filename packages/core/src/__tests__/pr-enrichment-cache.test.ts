import { describe, it, expect, vi } from "vitest";
import { createPREnrichmentCache } from "../pr-enrichment-cache.js";
import type {
  OrchestratorConfig,
  PluginRegistry,
  PREnrichmentData,
  SCM,
} from "../types.js";
import type { ProjectObserver } from "../observability.js";
import { createMockSCM, makePR, makeSession } from "./test-utils.js";

const noopObserver: ProjectObserver = {
  component: "test",
  recordOperation: () => {},
  setHealth: () => {},
};

function makeConfig(): OrchestratorConfig {
  return {
    configPath: "/tmp/ao.yaml",
    port: 3000,
    power: { preventIdleSleep: false },
    defaults: { runtime: "mock", agent: "mock-agent", workspace: "mock-ws", notifiers: [] },
    projects: {
      "my-app": {
        name: "My App",
        repo: "org/my-app",
        path: "/tmp/my-app",
        storageKey: "111111111111",
        defaultBranch: "main",
        sessionPrefix: "app",
        scm: { plugin: "github" },
      },
    },
    notifiers: {},
    notificationRouting: { urgent: [], action: [], warning: [], info: [] },
    reactions: {},
    readyThresholdMs: 300_000,
  };
}

function makeRegistry(scm: SCM | null): PluginRegistry {
  return {
    register: vi.fn(),
    get: vi.fn().mockImplementation((slot: string) => (slot === "scm" ? scm : null)),
    list: vi.fn().mockReturnValue([]),
    loadBuiltins: vi.fn(),
    loadFromConfig: vi.fn(),
  };
}

const enrichment: PREnrichmentData = {
  state: "open",
  ciStatus: "passing",
  reviewDecision: "approved",
  mergeable: true,
};

describe("pr-enrichment-cache", () => {
  it("populates from SCM batch and exposes get() by PR key", async () => {
    const scm = createMockSCM({
      enrichSessionsPRBatch: vi.fn().mockResolvedValue(
        new Map([["org/repo#42", enrichment]]),
      ),
    });
    const cache = createPREnrichmentCache({
      config: makeConfig(),
      registry: makeRegistry(scm),
      observer: noopObserver,
    });
    const session = makeSession({ pr: makePR({ owner: "org", repo: "repo", number: 42 }) });

    await cache.populate([session]);

    expect(scm.enrichSessionsPRBatch).toHaveBeenCalledTimes(1);
    expect(cache.get("org/repo#42")).toEqual(enrichment);
    expect(cache.get("unknown")).toBeUndefined();
  });

  it("dedupes PRs across sessions so the SCM sees each PR once", async () => {
    const batch = vi.fn().mockResolvedValue(new Map());
    const scm = createMockSCM({ enrichSessionsPRBatch: batch });
    const cache = createPREnrichmentCache({
      config: makeConfig(),
      registry: makeRegistry(scm),
      observer: noopObserver,
    });
    const pr = makePR({ owner: "org", repo: "repo", number: 42 });
    const sessions = [
      makeSession({ id: "s-1", pr }),
      makeSession({ id: "s-2", pr }),
    ];

    await cache.populate(sessions);

    expect(batch).toHaveBeenCalledTimes(1);
    const [prs] = batch.mock.calls[0]!;
    expect(prs).toHaveLength(1);
  });

  it("clears stale entries on re-populate", async () => {
    const scm = createMockSCM({
      enrichSessionsPRBatch: vi
        .fn()
        .mockResolvedValueOnce(new Map([["org/repo#42", enrichment]]))
        .mockResolvedValueOnce(new Map()),
    });
    const cache = createPREnrichmentCache({
      config: makeConfig(),
      registry: makeRegistry(scm),
      observer: noopObserver,
    });
    const session = makeSession({ pr: makePR({ owner: "org", repo: "repo", number: 42 }) });

    await cache.populate([session]);
    expect(cache.get("org/repo#42")).toEqual(enrichment);

    await cache.populate([session]);
    expect(cache.get("org/repo#42")).toBeUndefined();
  });

  it("skips sessions whose project has no SCM plugin configured", async () => {
    const batch = vi.fn().mockResolvedValue(new Map());
    const scm = createMockSCM({ enrichSessionsPRBatch: batch });
    const config = makeConfig();
    delete config.projects["my-app"]!.scm;

    const cache = createPREnrichmentCache({
      config,
      registry: makeRegistry(scm),
      observer: noopObserver,
    });
    await cache.populate([makeSession({ pr: makePR() })]);

    expect(batch).not.toHaveBeenCalled();
  });

  it("swallows batch errors so a failure doesn't break the poll", async () => {
    const scm = createMockSCM({
      enrichSessionsPRBatch: vi.fn().mockRejectedValue(new Error("GraphQL down")),
    });
    const cache = createPREnrichmentCache({
      config: makeConfig(),
      registry: makeRegistry(scm),
      observer: noopObserver,
    });
    const session = makeSession({ pr: makePR({ owner: "org", repo: "repo", number: 42 }) });

    await expect(cache.populate([session])).resolves.toBeUndefined();
    expect(cache.get("org/repo#42")).toBeUndefined();
  });
});
