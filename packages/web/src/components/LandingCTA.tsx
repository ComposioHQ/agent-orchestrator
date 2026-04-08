export function LandingCTA() {
  return (
    <section className="text-center py-40 px-6 bg-[radial-gradient(ellipse_at_center,rgba(255,255,255,0.015)_0%,transparent_60%)]">
      <div className="landing-reveal">
        <p className="text-[var(--landing-muted)] opacity-50 text-2xl font-sans font-[680] tracking-tight mb-4">
          Stop babysitting.
        </p>
        <h2 className="font-sans font-[680] tracking-tight font-normal text-[clamp(2.5rem,6vw,4.5rem)] leading-[1.05] tracking-[-2px] mb-4">
          Start <em className="italic text-[var(--landing-muted)]">orchestrating.</em>
        </h2>
        <div className="landing-card inline-flex items-center gap-3 rounded-full px-8 py-4 font-mono text-[0.9375rem] text-white mb-8">
          <span className="text-[var(--landing-muted)] opacity-40">$</span> npm i -g @composio/ao
        </div>
        <div className="flex items-center justify-center gap-4 flex-wrap">
          <a
            href="https://github.com/ComposioHQ/agent-orchestrator"
            target="_blank"
            rel="noopener noreferrer"
            className="liquid-glass-solid rounded-full px-9 py-3.5 text-[0.9375rem] no-underline transition-transform hover:scale-[1.03]"
          >
            View on GitHub
          </a>
        </div>
      </div>
    </section>
  );
}
