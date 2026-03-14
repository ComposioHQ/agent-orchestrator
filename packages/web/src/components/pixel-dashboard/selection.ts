import type { DashboardSession } from "@/lib/types";
import type { SceneEntity } from "./scene-model";

export interface ResolvedSelection {
  entity: SceneEntity | null;
  session: DashboardSession | null;
}

export function reconcileSelectedSessionId(
  selectedSessionId: string | null,
  sessions: DashboardSession[],
): string | null {
  if (!selectedSessionId) return null;
  return sessions.some((session) => session.id === selectedSessionId) ? selectedSessionId : null;
}

export function resolveSelectedSceneEntity(
  selectedSessionId: string | null,
  sessions: DashboardSession[],
  entities: SceneEntity[],
): ResolvedSelection {
  if (!selectedSessionId) {
    return { entity: null, session: null };
  }

  return {
    entity: entities.find((entity) => entity.sessionId === selectedSessionId) ?? null,
    session: sessions.find((session) => session.id === selectedSessionId) ?? null,
  };
}
