"use client";

export function LandingNav() {
  return (
    <nav className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-8 py-6 max-w-[80rem] mx-auto">
      <a
        href="#"
        className="text-[1.875rem] tracking-tight text-white no-underline font-sans font-[680] tracking-tight"
      >
        Agent Orchestrator
      </a>
      <ul className="hidden md:flex items-center gap-8 list-none">
        <li>
          <a href="#features" className="text-sm text-[var(--landing-muted)] no-underline hover:text-white transition-colors">
            Features
          </a>
        </li>
        <li>
          <a href="#how" className="text-sm text-[var(--landing-muted)] no-underline hover:text-white transition-colors">
            How It Works
          </a>
        </li>
      </ul>
      <a
        href="https://github.com/ComposioHQ/agent-orchestrator"
        target="_blank"
        rel="noopener noreferrer"
        className="liquid-glass-solid rounded-full px-6 py-2.5 text-sm no-underline transition-transform hover:scale-[1.03]"
      >
        GitHub
      </a>
    </nav>
  );
}
