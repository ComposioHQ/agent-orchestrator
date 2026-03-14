import { useEffect, useMemo, useRef, useState } from "react";
import type { ProjectInfo } from "@/lib/project-name";
import type { AttentionLevel } from "@/lib/types";
import type { DashboardSession } from "@/lib/types";
import {
  clampZoom,
  createInitialCameraState,
  getVisibleWorldRect,
  panCamera,
  zoomCameraAtPoint,
  type CameraState,
  type CameraViewport,
} from "./camera";
import { getOffscreenSelectionCue, resolveSelectedSceneEntity } from "./selection";
import { buildPixelWorldModel } from "./scene-model";
import { SessionSprite } from "./SessionSprite";

interface PixelWorldSceneProps {
  allProjectsView: boolean;
  onSelectSession?: (sessionId: string | null) => void;
  projectName?: string;
  projects: ProjectInfo[];
  selectedSessionId?: string | null;
  sessions: DashboardSession[];
}

export function PixelWorldScene({
  allProjectsView,
  onSelectSession,
  projectName,
  projects,
  selectedSessionId,
  sessions,
}: PixelWorldSceneProps) {
  const world = useMemo(
    () =>
      buildPixelWorldModel({
        allProjectsView,
        projectName,
        projects,
        sessions,
      }),
    [allProjectsView, projectName, projects, sessions],
  );
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState<CameraViewport>({ width: 960, height: 560 });
  const [camera, setCamera] = useState<CameraState>(() =>
    createInitialCameraState(world, { width: 960, height: 560 }),
  );
  const dragStateRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
  } | null>(null);
  const scopeKey = `${allProjectsView ? "all" : projectName ?? "single"}:${projects
    .map((project) => project.id)
    .join(",")}`;

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;

    const updateViewport = () => {
      const rect = element.getBoundingClientRect();
      setViewport({
        width: Math.max(Math.round(rect.width) || 960, 320),
        height: Math.max(Math.round(rect.height) || 560, 320),
      });
    };

    updateViewport();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateViewport);
      return () => window.removeEventListener("resize", updateViewport);
    }

    const observer = new ResizeObserver(() => updateViewport());
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setCamera(createInitialCameraState(world, viewport));
  }, [scopeKey, viewport.height, viewport.width, world]);

  const visibleRect = useMemo(() => getVisibleWorldRect(camera, viewport, world), [camera, viewport, world]);
  const selected = useMemo(
    () => resolveSelectedSceneEntity(selectedSessionId ?? null, sessions, world.entities),
    [selectedSessionId, sessions, world.entities],
  );
  const offscreenCue = useMemo(
    () => getOffscreenSelectionCue(selected.entity, camera, viewport),
    [camera, selected.entity, viewport],
  );

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    dragStateRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) return;

    const deltaX = event.clientX - dragState.x;
    const deltaY = event.clientY - dragState.y;
    dragStateRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    };

    setCamera((current) => panCamera(current, { x: deltaX, y: deltaY }, world, viewport));
  };

  const releasePointer = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragStateRef.current?.pointerId !== event.pointerId) return;
    dragStateRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    const zoomDelta = event.deltaY > 0 ? -0.12 : 0.12;
    const anchor = {
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
    };

    setCamera((current) =>
      zoomCameraAtPoint(current, clampZoom(current.zoom + zoomDelta), anchor, world, viewport),
    );
  };

  return (
    <section className="rounded-[24px] border border-[rgba(148,163,184,0.18)] bg-[linear-gradient(180deg,rgba(8,15,27,0.98),rgba(15,23,42,0.96))] p-4 shadow-[inset_0_1px_0_rgba(148,163,184,0.08)]">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-[rgba(148,163,184,0.8)]">
            Navigation
          </div>
          <p className="mt-1 text-[12px] text-[rgba(191,219,254,0.78)]">
            Drag to pan. Use the wheel or zoom controls. Framing stays put during live updates.
          </p>
          {selected.session ? (
            <p className="mt-1 text-[12px] text-[rgba(148,163,184,0.92)]">
              Selected: {selected.session.issueLabel ?? selected.session.summary ?? selected.session.id}
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() =>
              setCamera((current) =>
                zoomCameraAtPoint(
                  current,
                  current.zoom - 0.12,
                  { x: viewport.width / 2, y: viewport.height / 2 },
                  world,
                  viewport,
                ),
              )
            }
            className="rounded-[9px] border border-[rgba(148,163,184,0.22)] px-3 py-1.5 text-[12px] font-semibold text-[rgba(226,232,240,0.88)]"
          >
            -
          </button>
          <div className="min-w-[68px] text-center text-[11px] font-semibold uppercase tracking-[0.12em] text-[rgba(191,219,254,0.82)]">
            {Math.round(camera.zoom * 100)}%
          </div>
          <button
            type="button"
            onClick={() =>
              setCamera((current) =>
                zoomCameraAtPoint(
                  current,
                  current.zoom + 0.12,
                  { x: viewport.width / 2, y: viewport.height / 2 },
                  world,
                  viewport,
                ),
              )
            }
            className="rounded-[9px] border border-[rgba(148,163,184,0.22)] px-3 py-1.5 text-[12px] font-semibold text-[rgba(226,232,240,0.88)]"
          >
            +
          </button>
        </div>
      </div>
      <div
        ref={viewportRef}
        className="relative mx-auto h-[560px] overflow-hidden rounded-[20px] border border-[rgba(148,163,184,0.12)] bg-[radial-gradient(circle_at_top,rgba(59,130,246,0.12),transparent_32%),linear-gradient(180deg,rgba(15,23,42,0.96),rgba(8,15,27,0.98))] touch-none"
        data-testid="pixel-world-scene"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={releasePointer}
        onPointerCancel={releasePointer}
        onWheel={handleWheel}
      >
        <div className="pointer-events-none absolute right-4 top-4 z-20 rounded-full border border-[rgba(148,163,184,0.2)] bg-[rgba(8,15,27,0.72)] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-[rgba(191,219,254,0.85)]">
          View {Math.round(visibleRect.x)}-{Math.round(visibleRect.x + visibleRect.width)} /{" "}
          {Math.round(visibleRect.y)}-{Math.round(visibleRect.y + visibleRect.height)}
        </div>
        {offscreenCue?.isOffscreen && selected.session ? (
          <div
            className="pointer-events-none absolute z-20 flex -translate-x-1/2 -translate-y-1/2 items-center gap-2 rounded-full border border-[rgba(96,165,250,0.42)] bg-[rgba(15,23,42,0.92)] px-3 py-1.5 text-[11px] font-semibold text-[rgba(191,219,254,0.94)] shadow-[0_12px_24px_rgba(8,15,27,0.34)]"
            data-direction={offscreenCue.direction}
            data-testid="selected-session-locator"
            style={{
              left: offscreenCue.x,
              top: offscreenCue.y,
            }}
          >
            <span aria-hidden="true">{DIRECTION_GLYPHS[offscreenCue.direction]}</span>
            <span>{selected.session.issueLabel ?? selected.session.summary ?? selected.session.id}</span>
          </div>
        ) : null}
        <div
          className="absolute left-0 top-0 will-change-transform"
          style={{
            width: `${world.width}px`,
            height: `${world.height}px`,
            transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})`,
            transformOrigin: "top left",
          }}
        >
          <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(148,163,184,0.05)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,0.05)_1px,transparent_1px)] bg-[size:28px_28px]" />

          {world.districts.map((district) => (
            <section
              key={district.id}
              className="absolute overflow-hidden rounded-[28px] border border-[rgba(148,163,184,0.2)] bg-[linear-gradient(180deg,rgba(15,23,42,0.92),rgba(9,16,28,0.98))] shadow-[0_18px_36px_rgba(2,6,23,0.32)]"
              data-testid={`pixel-district-${district.id}`}
              style={{
                left: district.bounds.x,
                top: district.bounds.y,
                width: district.bounds.width,
                height: district.bounds.height,
              }}
            >
              <div className="flex items-center justify-between border-b border-[rgba(148,163,184,0.14)] px-5 py-4">
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-[rgba(148,163,184,0.75)]">
                    District {district.index + 1}
                  </div>
                  <h3 className="mt-1 text-[18px] font-semibold text-white">{district.name}</h3>
                </div>
                <div className="rounded-full border border-[rgba(96,165,250,0.32)] bg-[rgba(30,41,59,0.76)] px-3 py-1 text-[11px] uppercase tracking-[0.12em] text-[rgba(191,219,254,0.86)]">
                  {district.sessionCount} entities
                </div>
              </div>

              {Object.values(district.neighborhoods).map((neighborhood) => (
                <div
                  key={neighborhood.attentionLevel}
                  className={`absolute rounded-[18px] border ${NEIGHBORHOOD_TOKENS[neighborhood.attentionLevel].surface}`}
                  data-attention-level={neighborhood.attentionLevel}
                  data-testid={`pixel-neighborhood-${district.id}-${neighborhood.attentionLevel}`}
                  style={{
                    left: neighborhood.bounds.x - district.bounds.x,
                    top: neighborhood.bounds.y - district.bounds.y,
                    width: neighborhood.bounds.width,
                    height: neighborhood.bounds.height,
                  }}
                >
                  <div className="flex items-center justify-between gap-2 px-3 py-2">
                    <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[rgba(148,163,184,0.72)]">
                      {neighborhood.label}
                    </div>
                    <div
                      className={`rounded-full border px-2 py-1 text-[9px] font-bold uppercase tracking-[0.14em] ${NEIGHBORHOOD_TOKENS[neighborhood.attentionLevel].chip}`}
                    >
                      {NEIGHBORHOOD_TOKENS[neighborhood.attentionLevel].cue}
                    </div>
                  </div>
                </div>
              ))}
            </section>
          ))}

          {world.entities.map((entity) => (
            <SessionSprite
              key={entity.id}
              entity={entity}
              isSelected={entity.sessionId === selectedSessionId}
              onSelect={onSelectSession}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

const NEIGHBORHOOD_TOKENS: Record<
  AttentionLevel,
  {
    chip: string;
    cue: string;
    surface: string;
  }
> = {
  merge: {
    chip: "border-[rgba(74,222,128,0.42)] bg-[rgba(20,83,45,0.22)] text-[rgba(187,247,208,0.9)]",
    cue: "clear now",
    surface: "border-[rgba(74,222,128,0.18)] bg-[rgba(20,83,45,0.14)]",
  },
  respond: {
    chip: "border-[rgba(251,146,60,0.42)] bg-[rgba(124,45,18,0.2)] text-[rgba(254,215,170,0.92)]",
    cue: "needs reply",
    surface: "border-[rgba(251,146,60,0.18)] bg-[rgba(124,45,18,0.14)]",
  },
  review: {
    chip: "border-[rgba(248,113,113,0.42)] bg-[rgba(127,29,29,0.18)] text-[rgba(254,202,202,0.92)]",
    cue: "investigate",
    surface: "border-[rgba(248,113,113,0.18)] bg-[rgba(127,29,29,0.14)]",
  },
  pending: {
    chip: "border-[rgba(250,204,21,0.42)] bg-[rgba(113,63,18,0.18)] text-[rgba(254,240,138,0.9)]",
    cue: "waiting",
    surface: "border-[rgba(250,204,21,0.16)] bg-[rgba(113,63,18,0.14)]",
  },
  working: {
    chip: "border-[rgba(96,165,250,0.38)] bg-[rgba(30,41,59,0.22)] text-[rgba(191,219,254,0.9)]",
    cue: "in flight",
    surface: "border-[rgba(96,165,250,0.14)] bg-[rgba(30,41,59,0.14)]",
  },
  done: {
    chip: "border-[rgba(148,163,184,0.3)] bg-[rgba(15,23,42,0.28)] text-[rgba(226,232,240,0.78)]",
    cue: "archive",
    surface: "border-[rgba(148,163,184,0.14)] bg-[rgba(15,23,42,0.16)]",
  },
};

const DIRECTION_GLYPHS: Record<"down" | "left" | "right" | "up", string> = {
  down: "v",
  left: "<",
  right: ">",
  up: "^",
};
