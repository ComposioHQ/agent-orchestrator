import type { ProjectInfo } from "@/lib/project-name";
import type { AttentionLevel } from "@/lib/types";
import type { DashboardSession } from "@/lib/types";
import { buildPixelWorldModel } from "./scene-model";
import { SessionSprite } from "./SessionSprite";

interface PixelWorldSceneProps {
  allProjectsView: boolean;
  projectName?: string;
  projects: ProjectInfo[];
  sessions: DashboardSession[];
}

export function PixelWorldScene({
  allProjectsView,
  projectName,
  projects,
  sessions,
}: PixelWorldSceneProps) {
  const world = buildPixelWorldModel({
    allProjectsView,
    projectName,
    projects,
    sessions,
  });

  return (
    <div className="overflow-x-auto rounded-[24px] border border-[rgba(148,163,184,0.18)] bg-[linear-gradient(180deg,rgba(8,15,27,0.98),rgba(15,23,42,0.96))] p-4 shadow-[inset_0_1px_0_rgba(148,163,184,0.08)]">
      <div
        className="relative mx-auto overflow-hidden rounded-[20px] border border-[rgba(148,163,184,0.12)] bg-[radial-gradient(circle_at_top,rgba(59,130,246,0.12),transparent_32%),linear-gradient(180deg,rgba(15,23,42,0.96),rgba(8,15,27,0.98))]"
        data-testid="pixel-world-scene"
        style={{
          width: `${world.width}px`,
          minHeight: `${world.height}px`,
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
          <SessionSprite key={entity.id} entity={entity} />
        ))}
      </div>
    </div>
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
