"use client";

import { useEffect, useRef, useMemo, useState } from "react";
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  type Simulation,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from "d3-force";
import type { ActivityEvent, SessionGitActivity } from "@/lib/git-activity";

interface SessionSnapshot {
  id: string;
  branch: string | null;
  status: string;
  activity: string;
  pr: {
    number: number;
    state: string;
    ciStatus: string;
  } | null;
}

interface AgentMapProps {
  sessions: SessionSnapshot[];
  gitActivity: Record<string, SessionGitActivity>;
  events: ActivityEvent[];
}

interface Node extends SimulationNodeDatum {
  id: string;
  type: "main" | "agent" | "file";
  label: string;
  color: string;
  radius: number;
  pulse?: boolean;
  lastPulse?: number;
}

interface Link extends SimulationLinkDatum<Node> {
  source: string | Node;
  target: string | Node;
  type: "branch" | "file";
  strength: number;
  pulse?: boolean;
  lastPulse?: number;
}

/** Get a color for a session based on its ID (consistent hashing) */
function getSessionColor(sessionId: string): string {
  const colors = [
    "#58a6ff", // blue
    "#3fb950", // green
    "#a371f7", // purple
    "#f0883e", // orange
    "#f778ba", // pink
    "#79c0ff", // light blue
    "#7ee787", // light green
    "#d2a8ff", // light purple
  ];
  let hash = 0;
  for (let i = 0; i < sessionId.length; i++) {
    hash = (hash << 5) - hash + sessionId.charCodeAt(i);
    hash = hash & hash;
  }
  return colors[Math.abs(hash) % colors.length];
}

/** Get file color based on extension */
function getFileColor(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "ts":
    case "tsx":
      return "#3178c6";
    case "js":
    case "jsx":
      return "#f7df1e";
    case "css":
    case "scss":
      return "#264de4";
    case "json":
      return "#cbcb41";
    case "md":
      return "#083fa1";
    case "yaml":
    case "yml":
      return "#cb171e";
    default:
      return "#6e7681";
  }
}

export function AgentMap({ sessions, gitActivity, events }: AgentMapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const simulationRef = useRef<Simulation<Node, Link> | null>(null);
  const nodesRef = useRef<Node[]>([]);
  const linksRef = useRef<Link[]>([]);
  const animationRef = useRef<number>(0);
  const [dimensions, setDimensions] = useState({ width: 340, height: 400 });

  // Build graph data from sessions and activity
  const graphData = useMemo(() => {
    const nodes: Node[] = [];
    const links: Link[] = [];
    const fileMap = new Map<string, Set<string>>(); // file -> agent IDs

    // Central "main" node
    nodes.push({
      id: "main",
      type: "main",
      label: "main",
      color: "#484f58",
      radius: 20,
    });

    // Agent nodes
    for (const session of sessions) {
      const color = getSessionColor(session.id);
      const activity = gitActivity[session.id];
      const isActive = session.activity === "active";

      nodes.push({
        id: session.id,
        type: "agent",
        label: session.id,
        color,
        radius: isActive ? 14 : 10,
        pulse: isActive,
      });

      // Link agent to main
      links.push({
        source: "main",
        target: session.id,
        type: "branch",
        strength: 0.8,
      });

      // Track files touched by this agent
      if (activity?.recentFiles) {
        for (const file of activity.recentFiles.slice(0, 5)) {
          const existing = fileMap.get(file);
          if (existing) {
            existing.add(session.id);
          } else {
            fileMap.set(file, new Set([session.id]));
          }
        }
      }
    }

    // File nodes (shared files are larger)
    for (const [file, agentIds] of fileMap) {
      const shortName = file.split("/").pop() ?? file;
      nodes.push({
        id: `file:${file}`,
        type: "file",
        label: shortName,
        color: getFileColor(file),
        radius: 4 + Math.min(agentIds.size * 2, 6),
      });

      // Link file to all agents that touched it
      for (const agentId of agentIds) {
        links.push({
          source: agentId,
          target: `file:${file}`,
          type: "file",
          strength: 0.3,
        });
      }
    }

    return { nodes, links };
  }, [sessions, gitActivity]);

  // Mark nodes/links as pulsing based on recent events
  useEffect(() => {
    const now = Date.now();
    for (const event of events.slice(0, 10)) {
      const eventTime =
        typeof event.timestamp === "string"
          ? new Date(event.timestamp).getTime()
          : event.timestamp.getTime();
      if (now - eventTime < 5000) {
        // Within last 5 seconds
        const node = nodesRef.current.find((n) => n.id === event.sessionId);
        if (node) {
          node.pulse = true;
          node.lastPulse = now;
        }

        // Pulse links to files
        if (event.data.files) {
          for (const file of event.data.files) {
            const link = linksRef.current.find(
              (l) =>
                (typeof l.source === "object" ? l.source.id : l.source) === event.sessionId &&
                (typeof l.target === "object" ? l.target.id : l.target) === `file:${file}`,
            );
            if (link) {
              link.pulse = true;
              link.lastPulse = now;
            }
          }
        }
      }
    }
  }, [events]);

  // Handle resize
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const updateDimensions = () => {
      const parent = canvas.parentElement;
      if (parent) {
        setDimensions({
          width: parent.clientWidth,
          height: Math.max(parent.clientHeight - 30, 300),
        });
      }
    };

    updateDimensions();
    const resizeObserver = new ResizeObserver(updateDimensions);
    if (canvas.parentElement) {
      resizeObserver.observe(canvas.parentElement);
    }

    return () => resizeObserver.disconnect();
  }, []);

  // Initialize and update simulation
  useEffect(() => {
    const { nodes, links } = graphData;

    // Copy nodes and links (D3 mutates them)
    nodesRef.current = nodes.map((n) => ({ ...n }));
    linksRef.current = links.map((l) => ({ ...l }));

    // Create or update simulation
    if (!simulationRef.current) {
      simulationRef.current = forceSimulation<Node, Link>();
    }

    const sim = simulationRef.current;
    sim.nodes(nodesRef.current);
    sim
      .force(
        "link",
        forceLink<Node, Link>(linksRef.current)
          .id((d) => d.id)
          .distance((d) => (d.type === "branch" ? 60 : 40))
          .strength((d) => d.strength),
      )
      .force("charge", forceManyBody().strength(-80))
      .force("center", forceCenter(dimensions.width / 2, dimensions.height / 2))
      .force(
        "collide",
        forceCollide<Node>().radius((d) => d.radius + 3),
      )
      .alpha(0.5)
      .restart();

    return () => {
      sim.stop();
    };
  }, [graphData, dimensions]);

  // Animation loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = dimensions.width * dpr;
    canvas.height = dimensions.height * dpr;
    ctx.scale(dpr, dpr);

    const render = () => {
      const now = Date.now();

      // Clear canvas
      ctx.fillStyle = "#0d1117";
      ctx.fillRect(0, 0, dimensions.width, dimensions.height);

      // Draw links
      for (const link of linksRef.current) {
        const source = link.source as Node;
        const target = link.target as Node;
        if (!source.x || !source.y || !target.x || !target.y) continue;

        // Calculate pulse effect
        const pulseAge = link.lastPulse ? now - link.lastPulse : Infinity;
        const isPulsing = pulseAge < 2000;
        const pulseAlpha = isPulsing ? Math.max(0, 1 - pulseAge / 2000) : 0;

        ctx.beginPath();
        ctx.moveTo(source.x, source.y);
        ctx.lineTo(target.x, target.y);

        if (isPulsing) {
          ctx.strokeStyle = `rgba(88, 166, 255, ${0.3 + pulseAlpha * 0.7})`;
          ctx.lineWidth = 1 + pulseAlpha * 2;
        } else {
          ctx.strokeStyle =
            link.type === "branch" ? "rgba(72, 79, 88, 0.6)" : "rgba(72, 79, 88, 0.3)";
          ctx.lineWidth = link.type === "branch" ? 2 : 1;
        }
        ctx.stroke();

        // Clear pulse after fade
        if (pulseAge > 2000) {
          link.pulse = false;
        }
      }

      // Draw nodes
      for (const node of nodesRef.current) {
        if (!node.x || !node.y) continue;

        // Calculate pulse effect
        const pulseAge = node.lastPulse ? now - node.lastPulse : Infinity;
        const isPulsing = node.pulse || pulseAge < 3000;
        const pulsePhase = (now % 1500) / 1500;
        const pulseScale = isPulsing ? 1 + Math.sin(pulsePhase * Math.PI * 2) * 0.15 : 1;

        // Draw glow for active nodes
        if (isPulsing && node.type === "agent") {
          const gradient = ctx.createRadialGradient(
            node.x,
            node.y,
            node.radius * pulseScale,
            node.x,
            node.y,
            node.radius * pulseScale * 2.5,
          );
          gradient.addColorStop(0, `${node.color}40`);
          gradient.addColorStop(1, "transparent");
          ctx.fillStyle = gradient;
          ctx.beginPath();
          ctx.arc(node.x, node.y, node.radius * pulseScale * 2.5, 0, Math.PI * 2);
          ctx.fill();
        }

        // Draw node
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius * pulseScale, 0, Math.PI * 2);
        ctx.fillStyle = node.color;
        ctx.fill();

        // Draw border for main node
        if (node.type === "main") {
          ctx.strokeStyle = "#30363d";
          ctx.lineWidth = 2;
          ctx.stroke();
        }

        // Draw label for agents
        if (node.type === "agent" || node.type === "main") {
          ctx.font = node.type === "main" ? "bold 11px system-ui" : "10px system-ui";
          ctx.fillStyle = "#e6edf3";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";

          const label = node.type === "main" ? "main" : (node.label.split("-").pop() ?? node.label);
          ctx.fillText(label, node.x, node.y + node.radius + 12);
        }

        // Clear pulse after some time (but keep for active agents)
        if (pulseAge > 3000 && !node.pulse) {
          node.lastPulse = undefined;
        }
      }

      animationRef.current = requestAnimationFrame(render);
    };

    animationRef.current = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(animationRef.current);
    };
  }, [dimensions]);

  if (sessions.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <div className="mb-2 text-[var(--color-text-muted)]">
            <svg className="mx-auto h-12 w-12 opacity-50" fill="none" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth={1.5} />
              <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth={1.5} />
              <path stroke="currentColor" strokeWidth={1.5} d="M12 2v4M12 18v4M2 12h4M18 12h4" />
            </svg>
          </div>
          <p className="text-sm text-[var(--color-text-muted)]">No agents active</p>
          <p className="text-xs text-[var(--color-text-muted)] opacity-60">
            Agents will appear as orbiting nodes
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <canvas
        ref={canvasRef}
        style={{
          width: dimensions.width,
          height: dimensions.height,
        }}
        className="rounded-lg"
      />
      <div className="mt-2 flex items-center justify-center gap-4 text-[10px] text-[var(--color-text-muted)]">
        <div className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-[#484f58]" />
          main
        </div>
        <div className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-[#58a6ff]" />
          agent
        </div>
        <div className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-[#6e7681]" />
          file
        </div>
      </div>
    </div>
  );
}
