"use client";

export function LandingHero() {
  return (
    <div className="relative min-h-screen overflow-hidden">
      <div className="absolute inset-0 z-[1] landing-hero-grid" />
      <section className="relative z-10 flex flex-col items-center justify-center text-center px-6 pt-32 pb-20 min-h-screen">
        <div className="landing-fade-rise landing-card inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-xs text-[var(--landing-muted)] mb-8">
          <span className="w-1.5 h-1.5 rounded-full bg-[rgba(134,239,172,0.7)]" />
          Open Source · MIT Licensed · 5.9k GitHub Stars
        </div>
        <h1 className="landing-fade-rise font-normal text-[clamp(2.5rem,7vw,5rem)] leading-[1] tracking-[-2px] max-w-[56rem] font-sans font-[680] tracking-tight">
          Run 30 AI agents in parallel.
          <br />
          <span className="text-[var(--landing-muted)]">One dashboard.</span>
        </h1>
        <p className="landing-fade-rise-d1 text-[var(--landing-muted)] text-[clamp(0.9375rem,2vw,1.0625rem)] max-w-[38rem] mt-6 leading-[1.7]">
          Agent Orchestrator spawns Claude Code, Codex, Aider, and OpenCode
          in isolated git worktrees. Each agent gets its own branch, creates PRs,
          fixes CI, and addresses reviews autonomously.
        </p>
        <div className="landing-fade-rise-d2 flex items-center gap-3 mt-10 flex-wrap justify-center">
          <div className="landing-card rounded-full px-8 py-3.5 font-mono text-sm">
            <span className="text-[var(--landing-muted)] opacity-40">$</span> npx @composio/ao start
          </div>
          <a
            href="https://github.com/ComposioHQ/agent-orchestrator"
            target="_blank"
            rel="noopener noreferrer"
            className="liquid-glass-solid rounded-full px-8 py-3.5 text-sm no-underline transition-colors"
          >
            View on GitHub
          </a>
        </div>

        {/* Product preview — terminal showing actual ao output */}
        <div className="landing-fade-rise-d2 w-full max-w-[52rem] mt-16">
          <div className="landing-card rounded-2xl overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--landing-border-subtle)]">
              <div className="w-2.5 h-2.5 rounded-full bg-[rgba(255,240,220,0.08)]" />
              <div className="w-2.5 h-2.5 rounded-full bg-[rgba(255,240,220,0.08)]" />
              <div className="w-2.5 h-2.5 rounded-full bg-[rgba(255,240,220,0.08)]" />
              <span className="ml-2 font-mono text-[0.625rem] text-[var(--landing-muted)] opacity-40">
                agent-orchestrator — my-saas-app
              </span>
            </div>
            <div className="px-5 py-4 font-mono text-[0.8125rem] leading-[1.9] text-left">
              <div>
                <span className="text-[var(--landing-muted)] opacity-50">$</span>{" "}
                <span className="text-white">ao batch-spawn 42 43 44 45 46</span>
              </div>
              <div className="text-[var(--landing-muted)] opacity-50 mt-1">
                ⟡ Loaded agent-orchestrator.yaml (agent: claude-code, tracker: github)
              </div>
              <div className="text-[var(--landing-muted)] opacity-50">
                ⟡ Resolving 5 issues from ComposioHQ/my-saas-app
              </div>
              <div className="text-[var(--landing-muted)] opacity-50">
                ⟡ Creating worktrees in ~/.agent-orchestrator/a1b2c3/worktrees/
              </div>
              <div className="text-[rgba(134,239,172,0.8)] mt-1">
                ✓ s-001 → #42 Add user auth flow (claude-code)
              </div>
              <div className="text-[rgba(134,239,172,0.8)]">
                ✓ s-002 → #43 Fix pagination bug (codex)
              </div>
              <div className="text-[rgba(134,239,172,0.8)]">
                ✓ s-003 → #44 Add rate limiting (aider)
              </div>
              <div className="text-[rgba(134,239,172,0.8)]">
                ✓ s-004 → #45 Update API tests (claude-code)
              </div>
              <div className="text-[rgba(134,239,172,0.8)]">
                ✓ s-005 → #46 Refactor DB layer (opencode)
              </div>
              <div className="mt-1">
                <span className="landing-agent-dot mr-1" />
                <span className="text-[var(--landing-muted)] opacity-50">
                  5 agents working · Dashboard → http://localhost:3000
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
