const stats = [
  { number: "212", label: "PRs Merged" },
  { number: "75", label: "Issues Resolved" },
  { number: "814", label: "Forks" },
  { number: "19", label: "Contributors" },
];

export function LandingStats() {
  return (
    <section className="py-20 px-6 max-w-[72rem] mx-auto">
      <div className="landing-reveal grid grid-cols-2 md:grid-cols-4 gap-5">
        {stats.map((stat) => (
          <div
            key={stat.label}
            className="landing-card rounded-2xl py-8 px-6 text-center"
          >
            <div className="[font-family:var(--font-instrument-serif,serif)] text-[clamp(2rem,4vw,3rem)] tracking-tight mb-1">
              {stat.number}
            </div>
            <div className="text-xs text-[var(--landing-muted)] opacity-60">
              {stat.label}
            </div>
          </div>
        ))}
      </div>
      <div className="landing-reveal text-center mt-8">
        <a
          href="https://github.com/ComposioHQ/agent-orchestrator"
          target="_blank"
          rel="noopener noreferrer"
          className="landing-card inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-[0.8125rem] text-[var(--landing-muted)] no-underline transition-all hover:text-white mb-3"
        >
          <span className="text-[rgba(251,191,36,0.7)] text-sm">★</span>
          <span className="font-mono text-xs text-[var(--landing-fg)] opacity-80">5.9k</span>
          <span>stars on GitHub</span>
        </a>
        <br />
        <div className="landing-card inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-[0.8125rem] text-[var(--landing-muted)]">
          <span className="w-2 h-2 rounded-full bg-[rgba(134,239,172,0.7)] animate-pulse" />
          Built with itself — this repo is managed by Agent Orchestrator
        </div>
      </div>
    </section>
  );
}
