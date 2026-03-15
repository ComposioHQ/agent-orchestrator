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

const DISTRICT_MIN_HEIGHT = 420;
const DISTRICT_GAP = 40;
const WORLD_PADDING = 48;
const DISTRICT_HEADER_HEIGHT = 88;
const DISTRICT_INSET_X = 28;
const DISTRICT_BOTTOM_PADDING = 28;
const NEIGHBORHOOD_GAP = 18;
const NEIGHBORHOOD_HEADER_HEIGHT = 38;
const NEIGHBORHOOD_PADDING_X = 18;
const NEIGHBORHOOD_PADDING_TOP = 14;
const NEIGHBORHOOD_PADDING_BOTTOM = 18;
const ENTITY_FOOTPRINT_WIDTH = 108;
const ENTITY_FOOTPRINT_HEIGHT = 80;
const ENTITY_GAP_X = 16;
const ENTITY_GAP_Y = 16;
const DISTRICT_WIDTH_LARGE = 620;

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

  const districtsByProject = new Map(
    orderedProjectIds.map((projectId) => [
      projectId,
      sessions.filter((session) => session.projectId === projectId),
    ]),
  );
  const districtDrafts = orderedProjectIds.map((projectId, index) =>
    buildDistrictDraft({
      id: projectId,
      index,
      name: districtNames.get(projectId) ?? projectId,
      sessions: districtsByProject.get(projectId) ?? [],
    }),
  );
  const columns = districtDrafts.length > 1 ? Math.min(2, districtDrafts.length) : 1;
  const rowHeights = districtDrafts.reduce<number[]>((heights, district, index) => {
    const row = Math.floor(index / columns);
    heights[row] = Math.max(heights[row] ?? 0, district.bounds.height);
    return heights;
  }, []);

  const districts = districtDrafts.map((district, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const offsetY =
      WORLD_PADDING +
      rowHeights.slice(0, row).reduce((total, height) => total + height + DISTRICT_GAP, 0);
    const offsetX = WORLD_PADDING + column * (DISTRICT_WIDTH_LARGE + DISTRICT_GAP);
    return {
      ...district,
      bounds: {
        ...district.bounds,
        x: offsetX,
        y: offsetY,
      },
      neighborhoods: translateNeighborhoods(district.neighborhoods, offsetX, offsetY),
    };
  });

  const entities = districts.flatMap((district) =>
    buildDistrictEntities(district, districtsByProject.get(district.id) ?? []),
  );

  const rows = Math.max(1, Math.ceil(districts.length / columns));

  return {
    width: WORLD_PADDING * 2 + columns * DISTRICT_WIDTH_LARGE + (columns - 1) * DISTRICT_GAP,
    height:
      WORLD_PADDING * 2 +
      rowHeights.reduce((total, height) => total + height, 0) +
      Math.max(0, rows - 1) * DISTRICT_GAP,
    districts,
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

function buildDistrictDraft({
  id,
  index,
  name,
  sessions,
}: {
  id: string;
  index: number;
  name: string;
  sessions: DashboardSession[];
}): SceneDistrict {
  const counts = countSessionsByAttention(sessions);
  const contentWidth = DISTRICT_WIDTH_LARGE - DISTRICT_INSET_X * 2;
  const sideWidth = Math.floor((contentWidth - NEIGHBORHOOD_GAP) / 2);
  const doneWidth = 174;
  const workingWidth = contentWidth - doneWidth - NEIGHBORHOOD_GAP;
  const topHeight = Math.max(
    getNeighborhoodHeight(sideWidth, "merge", counts.merge),
    getNeighborhoodHeight(sideWidth, "respond", counts.respond),
  );
  const middleHeight = Math.max(
    getNeighborhoodHeight(sideWidth, "review", counts.review),
    getNeighborhoodHeight(sideWidth, "pending", counts.pending),
  );
  const bottomHeight = Math.max(
    getNeighborhoodHeight(workingWidth, "working", counts.working),
    getNeighborhoodHeight(doneWidth, "done", counts.done),
  );
  const districtHeight = Math.max(
    DISTRICT_MIN_HEIGHT,
    DISTRICT_HEADER_HEIGHT +
      topHeight +
      NEIGHBORHOOD_GAP +
      middleHeight +
      NEIGHBORHOOD_GAP +
      bottomHeight +
      DISTRICT_BOTTOM_PADDING,
  );
  const topY = DISTRICT_HEADER_HEIGHT;
  const middleY = topY + topHeight + NEIGHBORHOOD_GAP;
  const bottomY = middleY + middleHeight + NEIGHBORHOOD_GAP;
  const leftX = 0;
  const rightX = leftX + sideWidth + NEIGHBORHOOD_GAP;
  const bottomDoneX = contentWidth - doneWidth;

  return {
    id,
    index,
    name,
    bounds: {
      x: 0,
      y: 0,
      width: DISTRICT_WIDTH_LARGE,
      height: districtHeight,
    },
    neighborhoods: {
      merge: createNeighborhood("merge", "Merge gate", leftX, topY, sideWidth, topHeight),
      respond: createNeighborhood("respond", "Response yard", rightX, topY, sideWidth, topHeight),
      review: createNeighborhood("review", "Review forge", leftX, middleY, sideWidth, middleHeight),
      pending: createNeighborhood("pending", "Waiting square", rightX, middleY, sideWidth, middleHeight),
      working: createNeighborhood("working", "Workshop", leftX, bottomY, workingWidth, bottomHeight),
      done: createNeighborhood("done", "Archive grove", bottomDoneX, bottomY, doneWidth, bottomHeight),
    },
    sessionCount: sessions.length,
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
  const columns = getNeighborhoodColumns(bounds.width, attentionLevel, slotIndex + 1);
  const column = slotIndex % columns;
  const row = Math.floor(slotIndex / columns);
  const contentWidth = bounds.width - NEIGHBORHOOD_PADDING_X * 2;
  const usedWidth = columns * ENTITY_FOOTPRINT_WIDTH + (columns - 1) * ENTITY_GAP_X;
  const startX = bounds.x + NEIGHBORHOOD_PADDING_X + Math.max(0, (contentWidth - usedWidth) / 2);
  const startY = bounds.y + NEIGHBORHOOD_HEADER_HEIGHT + NEIGHBORHOOD_PADDING_TOP;

  return {
    x: startX + column * (ENTITY_FOOTPRINT_WIDTH + ENTITY_GAP_X) + ENTITY_FOOTPRINT_WIDTH / 2,
    y: startY + row * (ENTITY_FOOTPRINT_HEIGHT + ENTITY_GAP_Y) + ENTITY_FOOTPRINT_HEIGHT / 2,
  };
}

function createNeighborhood(
  attentionLevel: AttentionLevel,
  label: string,
  x: number,
  y: number,
  width: number,
  height: number,
): SceneNeighborhood {
  return {
    attentionLevel,
    label,
    bounds: { x, y, width, height },
  };
}

function countSessionsByAttention(
  sessions: DashboardSession[],
): Record<AttentionLevel, number> {
  return sessions.reduce<Record<AttentionLevel, number>>(
    (counts, session) => {
      counts[getAttentionLevel(session)] += 1;
      return counts;
    },
    {
      merge: 0,
      respond: 0,
      review: 0,
      pending: 0,
      working: 0,
      done: 0,
    },
  );
}

function getNeighborhoodColumns(
  width: number,
  attentionLevel: AttentionLevel,
  sessionCount: number,
): number {
  const preferredColumns =
    attentionLevel === "working" ? 3 : attentionLevel === "done" ? 1 : 2;
  const contentWidth = width - NEIGHBORHOOD_PADDING_X * 2;
  const fitColumns = Math.max(
    1,
    Math.floor((contentWidth + ENTITY_GAP_X) / (ENTITY_FOOTPRINT_WIDTH + ENTITY_GAP_X)),
  );
  return Math.max(1, Math.min(preferredColumns, fitColumns, Math.max(sessionCount, 1)));
}

function getNeighborhoodHeight(
  width: number,
  attentionLevel: AttentionLevel,
  sessionCount: number,
): number {
  if (sessionCount === 0) {
    return 120;
  }

  const columns = getNeighborhoodColumns(width, attentionLevel, sessionCount);
  const rows = Math.ceil(sessionCount / columns);

  return (
    NEIGHBORHOOD_HEADER_HEIGHT +
    NEIGHBORHOOD_PADDING_TOP +
    rows * ENTITY_FOOTPRINT_HEIGHT +
    Math.max(0, rows - 1) * ENTITY_GAP_Y +
    NEIGHBORHOOD_PADDING_BOTTOM
  );
}

function translateNeighborhoods(
  neighborhoods: Record<AttentionLevel, SceneNeighborhood>,
  offsetX: number,
  offsetY: number,
): Record<AttentionLevel, SceneNeighborhood> {
  return Object.fromEntries(
    Object.entries(neighborhoods).map(([key, neighborhood]) => [
      key,
      {
        ...neighborhood,
        bounds: {
          ...neighborhood.bounds,
          x: neighborhood.bounds.x + offsetX + DISTRICT_INSET_X,
          y: neighborhood.bounds.y + offsetY,
        },
      },
    ]),
  ) as Record<AttentionLevel, SceneNeighborhood>;
}
