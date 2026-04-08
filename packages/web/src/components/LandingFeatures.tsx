const features = [
  {
    icon: "⚡",
    title: "Parallel Execution",
    desc: "Run Claude Code, Codex, Aider, and OpenCode simultaneously. Each agent gets its own git worktree, its own branch, its own context. No conflicts, no coordination overhead.",
  },
  {
    icon: "🔄",
    title: "Autonomous Recovery",
    desc: "CI fails? The agent detects it, reads the logs, and pushes a fix. Review comments land? The agent addresses them. You sleep, your agents ship.",
  },
  {
    icon: "🔌",
    title: "Plugin Architecture",
    desc: "7 plugin slots: Runtime, Agent, Workspace, Tracker, SCM, Notifier, and Terminal. Swap any component. Use tmux or process runtime. GitHub or GitLab. Slack or webhooks.",
  },
  {
    icon: "📡",
    title: "Live Dashboard",
    desc: "Real-time Kanban board showing every agent's state. Attach to any agent's terminal via the browser. SSE updates, WebSocket terminals. One view for your entire fleet.",
  },
];

export function LandingFeatures() {
  return (
    <section className="py-[120px] px-6 max-w-[72rem] mx-auto" id="features">
      <div className="landing-reveal">
        <div className="text-xs tracking-[0.15em] uppercase text-[var(--landing-muted)] opacity-60 mb-6">
          Capabilities
        </div>
        <h2 className="[font-family:var(--font-instrument-serif,serif)] font-normal text-[clamp(2.5rem,6vw,4.5rem)] leading-[1.05] tracking-[-1.5px] mb-6">
          What we <em className="italic text-[var(--landing-muted)]">orchestrate</em>
        </h2>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-16">
        {features.map((f) => (
          <div
            key={f.title}
            className="landing-reveal landing-card rounded-2xl p-10"
          >
            <div className="w-12 h-12 rounded-xl bg-[var(--landing-surface)] flex items-center justify-center mb-6 text-xl">
              {f.icon}
            </div>
            <h3 className="[font-family:var(--font-instrument-serif,serif)] text-2xl mb-3 tracking-tight">
              {f.title}
            </h3>
            <p className="text-[var(--landing-muted)] text-[0.9375rem] leading-[1.7]">
              {f.desc}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
