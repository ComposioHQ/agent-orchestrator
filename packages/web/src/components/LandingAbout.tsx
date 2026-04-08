export function LandingAbout() {
  return (
    <div className="bg-[radial-gradient(ellipse_at_top,rgba(255,255,255,0.02)_0%,transparent_70%)]">
      <section className="landing-reveal py-[100px] px-6 max-w-[72rem] mx-auto">
        <div className="text-xs tracking-[0.15em] uppercase text-[var(--landing-muted)] opacity-60 mb-6">
          The problem
        </div>
        <h2 className="font-sans font-[680] tracking-tight font-normal text-[clamp(2rem,5vw,3.5rem)] leading-[1.1] tracking-[-1.5px] mb-8 max-w-[48rem]">
          You&apos;re running AI agents in 10 browser tabs.
          Checking if PRs landed. Re-running failed CI.{" "}
          <span className="text-[var(--landing-muted)]">
            Copy-pasting error logs between windows.
          </span>
        </h2>
        <p className="text-[clamp(0.9375rem,2vw,1.0625rem)] text-[var(--landing-muted)] leading-[1.8] max-w-[42rem]">
          Agent Orchestrator replaces that with a single command. Point it at
          your GitHub issues, pick your agents, and walk away. Each agent
          spawns in its own git worktree, creates PRs, fixes CI failures,
          addresses review comments, and moves toward merge — all visible from
          one real-time dashboard.
        </p>
      </section>
    </div>
  );
}
