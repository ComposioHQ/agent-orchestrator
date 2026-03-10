import type {
  Agent,
  CostEstimate,
  OrchestratorConfig,
  PluginRegistry,
  Session,
  UsageDial,
  UsageDialKind,
  UsageProvider,
  UsageSnapshot,
} from "@composio/ao-core";
import type { DashboardUsageResponse, SessionUsageResponse } from "@/lib/types";
import { resolveProject } from "@/lib/serialize";

interface UsageDialTemplate {
  id: string;
  kind: UsageDialKind;
  label: string;
}

interface SessionUsageSource {
  provider: UsageProvider | null;
  snapshot: UsageSnapshot | null;
  cost: CostEstimate | null;
}

const PROVIDER_ORDER: UsageProvider[] = ["codex", "claude-code"];

const DIAL_TEMPLATES: Record<UsageProvider, UsageDialTemplate[]> = {
  codex: [
    { id: "codex-5h", label: "5 hour usage limit", kind: "percent_remaining" },
    { id: "codex-weekly", label: "Weekly usage limit", kind: "percent_remaining" },
    {
      id: "codex-spark-5h",
      label: "GPT-5.3-Codex-Spark 5 hour usage limit",
      kind: "percent_remaining",
    },
    {
      id: "codex-spark-weekly",
      label: "GPT-5.3-Codex-Spark Weekly usage limit",
      kind: "percent_remaining",
    },
    { id: "codex-code-review", label: "Code review", kind: "percent_remaining" },
    { id: "codex-credits", label: "Credits remaining", kind: "absolute" },
  ],
  "claude-code": [
    {
      id: "claude-current-session",
      label: "Current session usage",
      kind: "percent_used",
    },
    {
      id: "claude-weekly-all-models",
      label: "Weekly limits - All models",
      kind: "percent_used",
    },
  ],
};

function providerForAgentName(agentName: string | undefined): UsageProvider | null {
  switch (agentName) {
    case "codex":
      return "codex";
    case "claude-code":
      return "claude-code";
    default:
      return null;
  }
}

function makeUnavailableDial(template: UsageDialTemplate): UsageDial {
  return {
    id: template.id,
    label: template.label,
    kind: template.kind,
    status: "unavailable",
    value: null,
    maxValue: template.kind === "absolute" ? null : 100,
    displayValue: "--",
    resetsAt: null,
  };
}

function normalizeSnapshot(
  provider: UsageProvider,
  snapshot: UsageSnapshot | null,
): UsageSnapshot {
  const dialMap = new Map(snapshot?.dials.map((dial) => [dial.id, dial]));

  return {
    provider,
    plan: snapshot?.plan ?? null,
    capturedAt: snapshot?.capturedAt ?? new Date().toISOString(),
    dials: DIAL_TEMPLATES[provider].map(
      (template) => dialMap.get(template.id) ?? makeUnavailableDial(template),
    ),
  };
}

function parseSnapshotTime(snapshot: UsageSnapshot): number {
  const parsed = Date.parse(snapshot.capturedAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function mergeSnapshots(
  provider: UsageProvider,
  snapshots: UsageSnapshot[],
): UsageSnapshot | null {
  if (snapshots.length === 0) return null;

  let latestSnapshot = snapshots[0];
  const dialEntries = new Map<string, { dial: UsageDial; timestamp: number }>();

  for (const snapshot of snapshots) {
    const timestamp = parseSnapshotTime(snapshot);
    if (timestamp >= parseSnapshotTime(latestSnapshot)) {
      latestSnapshot = snapshot;
    }

    for (const dial of snapshot.dials) {
      const existing = dialEntries.get(dial.id);
      if (!existing || timestamp >= existing.timestamp) {
        dialEntries.set(dial.id, { dial, timestamp });
      }
    }
  }

  return {
    provider,
    plan: latestSnapshot.plan ?? null,
    capturedAt: latestSnapshot.capturedAt,
    dials: Array.from(dialEntries.values()).map(({ dial }) => dial),
  };
}

function resolveAgent(
  session: Session,
  config: OrchestratorConfig,
  registry: PluginRegistry,
): { agent: Agent | null; provider: UsageProvider | null } {
  const project = resolveProject(session, config.projects);
  const agentName = session.metadata["agent"] ?? project?.agent ?? config.defaults.agent;
  const provider = providerForAgentName(agentName);

  try {
    return {
      agent: registry.get<Agent>("agent", agentName),
      provider,
    };
  } catch {
    return { agent: null, provider };
  }
}

async function loadSessionUsageSource(
  session: Session,
  config: OrchestratorConfig,
  registry: PluginRegistry,
  opts?: { includeCost?: boolean },
): Promise<SessionUsageSource> {
  const { agent, provider } = resolveAgent(session, config, registry);
  if (!agent || !provider) {
    return { provider: null, snapshot: null, cost: null };
  }

  const snapshotPromise = agent.getUsageSnapshot
    ? agent.getUsageSnapshot(session).catch(() => null)
    : Promise.resolve<UsageSnapshot | null>(null);

  const costPromise =
    opts?.includeCost === true
      ? session.agentInfo?.cost
        ? Promise.resolve(session.agentInfo.cost)
        : agent.getSessionInfo(session).then((info) => info?.cost ?? null).catch(() => null)
      : Promise.resolve<CostEstimate | null>(null);

  const [snapshot, cost] = await Promise.all([snapshotPromise, costPromise]);
  return { provider, snapshot, cost };
}

export async function getDashboardUsage(
  sessions: Session[],
  config: OrchestratorConfig,
  registry: PluginRegistry,
): Promise<DashboardUsageResponse> {
  const workerSessions = sessions.filter(
    (session) => !session.id.endsWith("-orchestrator") && session.activity !== "exited",
  );
  const sessionUsage = await Promise.all(
    workerSessions.map((session) => loadSessionUsageSource(session, config, registry)),
  );

  const mergedSnapshots = PROVIDER_ORDER.map((provider) => {
    const providerSnapshots = sessionUsage
      .filter((entry): entry is SessionUsageSource & { provider: UsageProvider } => {
        return entry.provider === provider;
      })
      .map((entry) => entry.snapshot)
      .filter((snapshot): snapshot is UsageSnapshot => snapshot !== null);

    return normalizeSnapshot(provider, mergeSnapshots(provider, providerSnapshots));
  });

  return {
    updatedAt: new Date().toISOString(),
    snapshots: mergedSnapshots,
  };
}

export async function getSessionUsage(
  session: Session,
  config: OrchestratorConfig,
  registry: PluginRegistry,
): Promise<SessionUsageResponse> {
  const source = await loadSessionUsageSource(session, config, registry, { includeCost: true });

  return {
    sessionId: session.id,
    provider: source.provider,
    cost: source.cost,
    snapshot: source.provider ? normalizeSnapshot(source.provider, source.snapshot) : null,
  };
}
