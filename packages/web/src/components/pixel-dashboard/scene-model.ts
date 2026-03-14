import type { ProjectInfo } from "@/lib/project-name";
import {
  ATTENTION_LEVEL_ORDER,
  getAttentionLevel,
  type AttentionLevel,
  type DashboardSession,
} from "@/lib/types";

export interface SceneRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SceneNeighborhood {
  attentionLevel: AttentionLevel;
  label: string;
  bounds: SceneRect;
}

export interface SceneDistrict {
  id: string;
  name: string;
  index: number;
  bounds: SceneRect;
  neighborhoods: Record<AttentionLevel, SceneNeighborhood>;
  sessionCount: number;
}

export interface SceneEntity {
  id: string;
  sessionId: string;
  projectId: string;
  districtId: string;
  attentionLevel: AttentionLevel;
  neighborhoodKey: AttentionLevel;
  summary: string;
  label: string;
  branch: string | null;
  issueLabel: string | null;
  isArchived: boolean;
  slotIndex: number;
  position: {
    x: number;
    y: number;
  };
}

export interface PixelWorldModel {
  width: number;
  height: number;
  districts: SceneDistrict[];
  entities: SceneEntity[];
}

interface BuildWorldModelOptions {
  allProjectsView: boolean;
  projectName?: string;
  projects: ProjectInfo[];
  sessions: DashboardSession[];
}

const DISTRICT_WIDTH = 500;
const DISTRICT_HEIGHT = 420;
const DISTRICT_GAP = 40;
const WORLD_PADDING = 48;
const SLOT_SPACING_X = 52;
const SLOT_SPACING_Y = 46;
const SLOT_PADDING_X = 28;
const SLOT_PADDING_Y = 34;

export function buildPixelWorldModel({
  allProjectsView,
  projectName,
  projects,
  sessions,
}: BuildWorldModelOptions): PixelWorldModel {
  const orderedProjectIds = getOrderedProjectIds({ allProjectsView, projects, sessions });
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  const districtNames = new Map(
    orderedProjectIds.map((projectId, index) => [
      projectId,
      projectNames.get(projectId) ??
        (index === 0 && !allProjectsView && projectName ? projectName : projectId),
    ]),
  );

  const districtBounds = orderedProjectIds.map((projectId, index) => {
    const columns = orderedProjectIds.length > 1 ? Math.min(2, orderedProjectIds.length) : 1;
    const column = index % columns;
    const row = Math.floor(index / columns);

    return {
      id: projectId,
      index,
      bounds: {
        x: WORLD_PADDING + column * (DISTRICT_WIDTH + DISTRICT_GAP),
        y: WORLD_PADDING + row * (DISTRICT_HEIGHT + DISTRICT_GAP),
        width: DISTRICT_WIDTH,
        height: DISTRICT_HEIGHT,
      },
    };
  });

  const districts = districtBounds.map(({ id, index, bounds }) => ({
    id,
    name: districtNames.get(id) ?? id,
    index,
    bounds,
    neighborhoods: buildNeighborhoods(bounds),
    sessionCount: sessions.filter((session) => session.projectId === id).length,
  }));

  const districtMap = new Map(districts.map((district) => [district.id, district]));
  const entities = districts.flatMap((district) => {
    const districtSessions = sessions.filter((session) => session.projectId === district.id);
    return buildDistrictEntities(district, districtSessions);
  });

  const columns = districts.length > 1 ? Math.min(2, districts.length) : 1;
  const rows = Math.max(1, Math.ceil(districts.length / columns));

  return {
    width: WORLD_PADDING * 2 + columns * DISTRICT_WIDTH + (columns - 1) * DISTRICT_GAP,
    height: WORLD_PADDING * 2 + rows * DISTRICT_HEIGHT + (rows - 1) * DISTRICT_GAP,
    districts: districts.map((district) => districtMap.get(district.id) ?? district),
    entities,
  };
}

function getOrderedProjectIds({
  allProjectsView,
  projects,
  sessions,
}: Pick<BuildWorldModelOptions, "allProjectsView" | "projects" | "sessions">): string[] {
  const sessionProjectIds = [...new Set(sessions.map((session) => session.projectId))].sort();
  const projectIdsFromConfig = projects.map((project) => project.id);

  if (!allProjectsView) {
    const focusedProjectId = sessionProjectIds[0] ?? projectIdsFromConfig[0];
    return focusedProjectId ? [focusedProjectId] : [];
  }

  const ordered = [...projectIdsFromConfig];
  for (const projectId of sessionProjectIds) {
    if (!ordered.includes(projectId)) {
      ordered.push(projectId);
    }
  }

  return ordered;
}

function buildNeighborhoods(bounds: SceneRect): Record<AttentionLevel, SceneNeighborhood> {
  const x = bounds.x;
  const y = bounds.y;
  const width = bounds.width;
  const height = bounds.height;

  return {
    merge: {
      attentionLevel: "merge",
      label: "Merge gate",
      bounds: {
        x: x + 28,
        y: y + 62,
        width: 196,
        height: 108,
      },
    },
    respond: {
      attentionLevel: "respond",
      label: "Response yard",
      bounds: {
        x: x + width - 224,
        y: y + 62,
        width: 196,
        height: 108,
      },
    },
    review: {
      attentionLevel: "review",
      label: "Review forge",
      bounds: {
        x: x + 28,
        y: y + 188,
        width: 196,
        height: 104,
      },
    },
    pending: {
      attentionLevel: "pending",
      label: "Waiting square",
      bounds: {
        x: x + width - 224,
        y: y + 188,
        width: 196,
        height: 104,
      },
    },
    working: {
      attentionLevel: "working",
      label: "Workshop",
      bounds: {
        x: x + 28,
        y: y + height - 132,
        width: 286,
        height: 86,
      },
    },
    done: {
      attentionLevel: "done",
      label: "Archive grove",
      bounds: {
        x: x + width - 168,
        y: y + height - 150,
        width: 140,
        height: 104,
      },
    },
  };
}

function buildDistrictEntities(district: SceneDistrict, sessions: DashboardSession[]): SceneEntity[] {
  const byAttention = new Map<AttentionLevel, DashboardSession[]>(
    ATTENTION_LEVEL_ORDER.map((level) => [level, []]),
  );

  for (const session of sessions) {
    byAttention.get(getAttentionLevel(session))?.push(session);
  }

  return ATTENTION_LEVEL_ORDER.flatMap((attentionLevel) => {
    const orderedSessions = [...(byAttention.get(attentionLevel) ?? [])].sort(compareSessions);
    const neighborhood = district.neighborhoods[attentionLevel];

    return orderedSessions.map((session, slotIndex) => ({
      id: `${district.id}:${attentionLevel}:${session.id}`,
      sessionId: session.id,
      projectId: session.projectId,
      districtId: district.id,
      attentionLevel,
      neighborhoodKey: attentionLevel,
      summary: session.summary ?? session.id,
      label: session.issueLabel ?? session.summary ?? session.branch ?? session.id,
      branch: session.branch,
      issueLabel: session.issueLabel,
      isArchived: attentionLevel === "done",
      slotIndex,
      position: getSlotPosition(neighborhood.bounds, attentionLevel, slotIndex),
    }));
  });
}

function compareSessions(left: DashboardSession, right: DashboardSession): number {
  const leftCreatedAt = Date.parse(left.createdAt);
  const rightCreatedAt = Date.parse(right.createdAt);

  if (Number.isFinite(leftCreatedAt) && Number.isFinite(rightCreatedAt) && leftCreatedAt !== rightCreatedAt) {
    return leftCreatedAt - rightCreatedAt;
  }

  return left.id.localeCompare(right.id);
}

function getSlotPosition(
  bounds: SceneRect,
  attentionLevel: AttentionLevel,
  slotIndex: number,
): { x: number; y: number } {
  const columns = attentionLevel === "working" ? 4 : attentionLevel === "done" ? 2 : 3;
  const column = slotIndex % columns;
  const row = Math.floor(slotIndex / columns);
  const availableWidth = bounds.width - SLOT_PADDING_X * 2;
  const columnGap = Math.max(SLOT_SPACING_X, availableWidth / (columns - 1));

  return {
    x: bounds.x + SLOT_PADDING_X + column * columnGap,
    y: bounds.y + SLOT_PADDING_Y + row * SLOT_SPACING_Y,
  };
}
