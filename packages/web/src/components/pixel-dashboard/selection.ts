import type { DashboardSession } from "@/lib/types";
import type { SceneEntity } from "./scene-model";
import type { CameraState, CameraViewport } from "./camera";

export interface ResolvedSelection {
  entity: SceneEntity | null;
  session: DashboardSession | null;
}

export interface OffscreenSelectionCue {
  direction: "down" | "left" | "right" | "up";
  isOffscreen: boolean;
  x: number;
  y: number;
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

export function getOffscreenSelectionCue(
  entity: SceneEntity | null,
  camera: CameraState,
  viewport: CameraViewport,
  margin = 24,
): OffscreenSelectionCue | null {
  if (!entity) return null;

  const x = entity.position.x * camera.zoom + camera.x;
  const y = entity.position.y * camera.zoom + camera.y;
  const isVisible = x >= 0 && x <= viewport.width && y >= 0 && y <= viewport.height;

  if (isVisible) {
    return {
      direction: "right",
      isOffscreen: false,
      x,
      y,
    };
  }

  const clampedX = clampNumber(x, margin, viewport.width - margin);
  const clampedY = clampNumber(y, margin, viewport.height - margin);
  const centerX = viewport.width / 2;
  const centerY = viewport.height / 2;
  const dx = x - centerX;
  const dy = y - centerY;
  const direction =
    Math.abs(dx) >= Math.abs(dy)
      ? dx < 0
        ? "left"
        : "right"
      : dy < 0
        ? "up"
        : "down";

  return {
    direction,
    isOffscreen: true,
    x: clampedX,
    y: clampedY,
  };
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
