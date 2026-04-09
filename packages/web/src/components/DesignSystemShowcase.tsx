"use client";

import { EmptyState } from "./Skeleton";

type Tone = {
  name: string;
  token: string;
  note: string;
};

const surfaceTones: Tone[] = [
  { name: "Base", token: "--color-bg-base", note: "App canvas and page backdrop" },
  { name: "Surface", token: "--color-bg-surface", note: "Primary cards and panels" },
  { name: "Elevated", token: "--color-bg-elevated", note: "Raised sections and hover layers" },
  { name: "Sidebar", token: "--color-bg-sidebar", note: "Project navigation rail" },
];

const accentTones: Tone[] = [
  { name: "Primary", token: "--color-accent", note: "Core interactive accent" },
  { name: "Amber", token: "--color-accent-amber", note: "Orchestrator CTA and warm emphasis" },
  { name: "Working", token: "--color-status-working", note: "Active session signal" },
  { name: "Ready", token: "--color-status-ready", note: "Merge-ready / success states" },
  { name: "Respond", token: "--color-status-respond", note: "Human input needed" },
  { name: "Error", token: "--color-status-error", note: "Failure and termination states" },
];

function TerminalIcon() {
  return (
    <svg width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="M6 10l4 2-4 2M14 14h4" />
    </svg>
  );
}

function CheckIcon({ size = 8 }: { size?: number }) {
  return (
    <svg width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function XIcon({ size = 9 }: { size?: number }) {
  return (
    <svg width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

function PeopleIcon() {
  return (
    <svg width="9" height="9" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function CommentIcon() {
  return (
    <svg width="9" height="9" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
    </svg>
  );
}

function MergeIcon() {
  return (
    <svg width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
      <circle cx="6" cy="6" r="2" />
      <circle cx="18" cy="18" r="2" />
      <circle cx="18" cy="6" r="2" />
      <path d="M8 6h5a3 3 0 0 1 3 3v7" />
    </svg>
  );
}

export function DesignSystemShowcase() {
  return (
    <div className="design-system-page">
      <div className="design-system-page__hero">
        <div>
          <p className="design-system-page__eyebrow">Internal Reference</p>
          <h1 className="design-system-page__title">Agent Orchestrator Design System</h1>
          <p className="design-system-page__lede">
            Canonical visual reference for the dashboard shell, kanban states, session detail
            patterns, tokens, and interaction primitives currently used in the app.
          </p>
        </div>
        <div className="design-system-page__meta">
          <span className="design-system-chip">Theme-aware</span>
          <span className="design-system-chip">Dashboard UI</span>
          <span className="design-system-chip">Reference only</span>
        </div>
      </div>

      <div className="design-system-page__nav">
        <a href="#tokens">Tokens</a>
        <a href="#type">Typography</a>
        <a href="#shell">Shell</a>
        <a href="#kanban">Kanban</a>
        <a href="#done-sessions">Done</a>
        <a href="#prs-page">PRs</a>
        <a href="#session-detail">Session Detail</a>
      </div>

      <section id="tokens" className="design-system-section">
        <div className="design-system-section__head">
          <p className="design-system-section__eyebrow">Foundation</p>
          <h2 className="design-system-section__title">Color Tokens</h2>
        </div>
        <div className="design-system-swatch-grid">
          {surfaceTones.map((tone) => (
            <div key={tone.token} className="design-system-swatch">
              <div
                className="design-system-swatch__chip"
                style={{ background: `var(${tone.token})` }}
              />
              <div>
                <p className="design-system-swatch__name">{tone.name}</p>
                <p className="design-system-swatch__token">{tone.token}</p>
                <p className="design-system-swatch__note">{tone.note}</p>
              </div>
            </div>
          ))}
          {accentTones.map((tone) => (
            <div key={tone.token} className="design-system-swatch">
              <div
                className="design-system-swatch__chip"
                style={{ background: `var(${tone.token})` }}
              />
              <div>
                <p className="design-system-swatch__name">{tone.name}</p>
                <p className="design-system-swatch__token">{tone.token}</p>
                <p className="design-system-swatch__note">{tone.note}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section id="type" className="design-system-section">
        <div className="design-system-section__head">
          <p className="design-system-section__eyebrow">Foundation</p>
          <h2 className="design-system-section__title">Typography</h2>
        </div>
        <div className="design-system-type-grid">
          <div className="design-system-type-card">
            <p className="design-system-type-card__label">Display</p>
            <p className="design-system-type-card__display">Dashboard</p>
            <p className="design-system-type-card__note">
              Primary page heading with calm weight and warm-neutral tone.
            </p>
          </div>
          <div className="design-system-type-card">
            <p className="design-system-type-card__label">Section Label</p>
            <p className="design-system-type-card__mono">WORKING · PENDING · REVIEW</p>
            <p className="design-system-type-card__note">
              Mono uppercase labels for board states and low-noise metadata.
            </p>
          </div>
          <div className="design-system-type-card">
            <p className="design-system-type-card__label">Body</p>
            <p className="design-system-type-card__body">
              Live agent sessions, pull requests, and merge status should read clearly without
              feeling heavy or over-designed.
            </p>
            <p className="design-system-type-card__note">
              Warm editorial sans with restrained contrast.
            </p>
          </div>
        </div>
      </section>

      <section id="shell" className="design-system-section">
        <div className="design-system-section__head">
          <p className="design-system-section__eyebrow">Application Chrome</p>
          <h2 className="design-system-section__title">Shell Patterns</h2>
        </div>
        <div className="design-system-shell">
          <header className="dashboard-app-header">
            <button
              type="button"
              className="dashboard-shell__sidebar-toggle"
              aria-label="Toggle sidebar"
            >
              <svg fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
                <rect x="4" y="4" width="16" height="16" rx="2" />
                <path d="M10 4v16" />
              </svg>
            </button>
            <div className="dashboard-app-header__brand">Agent Orchestrator</div>
            <div className="dashboard-app-header__sep" />
            <div className="dashboard-app-header__project">agent-orchestrator</div>
            <div className="dashboard-app-header__spacer" />
          </header>

          <div className="design-system-shell__body">
            <aside className="project-sidebar">
              <div className="project-sidebar__compact-hdr">
                <span className="project-sidebar__sect-label">Projects</span>
                <button type="button" className="project-sidebar__add-btn" aria-label="New project">
                  <svg fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                </button>
              </div>
              <div className="project-sidebar__tree">
                <div className="project-sidebar__project">
                  <button
                    type="button"
                    className="project-sidebar__proj-toggle project-sidebar__proj-toggle--active"
                  >
                    <svg
                      className="project-sidebar__proj-chevron project-sidebar__proj-chevron--open"
                      width="10"
                      height="10"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      viewBox="0 0 24 24"
                    >
                      <path d="m9 18 6-6-6-6" />
                    </svg>
                    <span className="project-sidebar__proj-name">Agent Orchestrator</span>
                    <span className="project-sidebar__proj-badge project-sidebar__proj-badge--active">
                      4
                    </span>
                  </button>
                  <div className="project-sidebar__sessions">
                    <a
                      className="project-sidebar__sess-row project-sidebar__sess-row--active"
                      href="#kanban-working"
                    >
                      <span className="sidebar-session-dot sidebar-session-dot--glow" data-level="working" />
                      <span className="project-sidebar__sess-label project-sidebar__sess-label--active">
                        Polish kanban shell
                      </span>
                      <span className="project-sidebar__sess-status">working</span>
                    </a>
                    <a className="project-sidebar__sess-row" href="#kanban-review">
                      <span className="sidebar-session-dot" data-level="review" />
                      <span className="project-sidebar__sess-label">Address review comments</span>
                      <span className="project-sidebar__sess-status">review</span>
                    </a>
                  </div>
                </div>
              </div>
              <div className="project-sidebar__footer">
                <button type="button" className="project-sidebar__footer-btn">
                  <svg fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
                    <path d="M12 3v2.5M12 18.5V21M4.93 4.93l1.77 1.77M17.3 17.3l1.77 1.77M3 12h2.5M18.5 12H21M4.93 19.07l1.77-1.77M17.3 6.7l1.77-1.77" />
                    <circle cx="12" cy="12" r="4.5" />
                  </svg>
                  Theme
                </button>
              </div>
            </aside>

            <main className="design-system-shell__main">
              <p className="design-system-shell__caption">
                Shell balance: warm navigation rail, quieter chrome, stronger content hierarchy.
              </p>
            </main>
          </div>
        </div>
      </section>

      <section id="kanban" className="design-system-section">
        <div className="design-system-section__head">
          <p className="design-system-section__eyebrow">Board Patterns</p>
          <h2 className="design-system-section__title">Kanban Reference</h2>
        </div>

        <div className="design-ref-board-wrap">
          <div className="design-ref-main-subhead">
            <h3 className="design-ref-main-title">Dashboard</h3>
            <p className="design-ref-main-subtitle">
              Live agent sessions, pull requests, and merge status.
            </p>
          </div>

          <div className="design-ref-board">
            <div className="design-ref-column">
              <div className="design-ref-col-head">
                <div className="design-ref-col-indicator design-ref-col-indicator--working" />
                <span className="design-ref-col-head__label">Working</span>
                <span className="design-ref-col-head__count">1</span>
              </div>
              <div className="design-ref-col-body">
                <div className="design-ref-card design-ref-card--working">
                  <div className="design-ref-card__header">
                    <div className="design-ref-adot design-ref-adot--working" />
                    <span className="design-ref-card__id">abc123</span>
                    <button type="button" className="design-ref-card__terminal">
                      <TerminalIcon />
                      terminal
                    </button>
                  </div>
                  <div className="design-ref-card__title-wrap">
                    <p className="design-ref-card__title design-ref-card__title--working">
                      Fix auth token refresh race condition on login
                    </p>
                  </div>
                  <div className="design-ref-card__meta">
                    <span className="design-ref-meta-branch">fix/auth-token-refresh</span>
                  </div>
                  <div className="design-ref-card__secondary">
                    Reproducing the race condition with concurrent refresh calls…
                  </div>
                  <div className="design-ref-card__footer">
                    <span className="design-ref-card__status">working</span>
                    <button className="design-ref-card__kill" type="button" title="Terminate session">
                      <TrashIcon />
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div className="design-ref-column">
              <div className="design-ref-col-head">
                <div className="design-ref-col-indicator design-ref-col-indicator--pending" />
                <span className="design-ref-col-head__label">Pending</span>
                <span className="design-ref-col-head__count">1</span>
              </div>
              <div className="design-ref-col-body">
                <div className="design-ref-card design-ref-card--pending">
                  <div className="design-ref-card__header">
                    <div className="design-ref-adot design-ref-adot--idle" />
                    <span className="design-ref-card__id">def456</span>
                    <button type="button" className="design-ref-card__terminal">
                      <TerminalIcon />
                      terminal
                    </button>
                  </div>
                  <div className="design-ref-card__title-wrap">
                    <p className="design-ref-card__title">
                      Add dark mode support to design system tokens
                    </p>
                  </div>
                  <div className="design-ref-card__meta">
                    <span className="design-ref-meta-branch">feat/dark-mode-tok…</span>
                    <span className="design-ref-meta-sep">·</span>
                    <a href="#pr-42" className="design-ref-meta-pr">#42</a>
                    <span className="design-ref-meta-diff">
                      <span className="design-ref-diff--add">+234</span>
                      <span className="design-ref-diff--del">-18</span>
                      <span className="design-ref-diff--size">M</span>
                    </span>
                  </div>
                  <div className="design-ref-card__alerts">
                    <div className="design-ref-alert-row design-ref-alert-row--ci">
                      <span className="design-ref-alert-row__icon">
                        <XIcon />
                      </span>
                      <a href="#checks" className="design-ref-alert-row__text">2 checks failing</a>
                      <button className="design-ref-alert-row__action" type="button">ask to fix</button>
                    </div>
                  </div>
                  <div className="design-ref-card__footer">
                    <span className="design-ref-card__status">ci_failed</span>
                    <button className="design-ref-card__kill" type="button" title="Terminate session">
                      <TrashIcon />
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div className="design-ref-column" id="kanban-review">
              <div className="design-ref-col-head">
                <div className="design-ref-col-indicator design-ref-col-indicator--review" />
                <span className="design-ref-col-head__label">Review</span>
                <span className="design-ref-col-head__count">1</span>
              </div>
              <div className="design-ref-col-body">
                <div className="design-ref-card design-ref-card--review">
                  <div className="design-ref-card__header">
                    <div className="design-ref-adot design-ref-adot--ready" />
                    <span className="design-ref-card__id">ghi789</span>
                    <button type="button" className="design-ref-card__terminal">
                      <TerminalIcon />
                      terminal
                    </button>
                  </div>
                  <div className="design-ref-card__title-wrap">
                    <p className="design-ref-card__title">
                      Refactor API client to use fetch with retry logic
                    </p>
                  </div>
                  <div className="design-ref-card__meta">
                    <span className="design-ref-meta-branch">refactor/api-client</span>
                    <span className="design-ref-meta-sep">·</span>
                    <a href="#pr-38" className="design-ref-meta-pr">#38</a>
                    <span className="design-ref-meta-diff">
                      <span className="design-ref-diff--add">+89</span>
                      <span className="design-ref-diff--del">-156</span>
                      <span className="design-ref-diff--size">S</span>
                    </span>
                  </div>
                  <div className="design-ref-card__ci">
                    <span className="design-ref-ci-chip design-ref-ci-chip--pass">
                      <CheckIcon />
                      typecheck
                    </span>
                    <span className="design-ref-ci-chip design-ref-ci-chip--pass">
                      <CheckIcon />
                      tests (47)
                    </span>
                  </div>
                  <div className="design-ref-card__alerts">
                    <div className="design-ref-alert-row design-ref-alert-row--review">
                      <span className="design-ref-alert-row__icon">
                        <PeopleIcon />
                      </span>
                      <a href="#review" className="design-ref-alert-row__text">needs review</a>
                      <button className="design-ref-alert-row__action" type="button">ask to post</button>
                    </div>
                    <div className="design-ref-alert-row design-ref-alert-row--comment">
                      <span className="design-ref-alert-row__icon">
                        <CommentIcon />
                      </span>
                      <a href="#comments" className="design-ref-alert-row__text">
                        3 unresolved comments
                      </a>
                      <button className="design-ref-alert-row__action" type="button">
                        ask to resolve
                      </button>
                    </div>
                  </div>
                  <div className="design-ref-card__footer">
                    <span className="design-ref-card__status">review_pending</span>
                    <button className="design-ref-card__kill" type="button" title="Terminate session">
                      <TrashIcon />
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div className="design-ref-column">
              <div className="design-ref-col-head">
                <div className="design-ref-col-indicator design-ref-col-indicator--respond" />
                <span className="design-ref-col-head__label">Respond</span>
                <span className="design-ref-col-head__count">1</span>
              </div>
              <div className="design-ref-col-body">
                <div className="design-ref-card design-ref-card--respond">
                  <div className="design-ref-card__header">
                    <div className="design-ref-adot design-ref-adot--waiting" />
                    <span className="design-ref-card__id">jkl012</span>
                    <button type="button" className="design-ref-card__terminal">
                      <TerminalIcon />
                      terminal
                    </button>
                  </div>
                  <div className="design-ref-card__title-wrap">
                    <p className="design-ref-card__title">
                      Update onboarding flow with new user research
                    </p>
                  </div>
                  <div className="design-ref-card__meta">
                    <span className="design-ref-meta-branch">feat/onboarding-v2</span>
                    <span className="design-ref-meta-sep">·</span>
                    <a href="#pr-45" className="design-ref-meta-pr">#45</a>
                  </div>
                  <div className="design-ref-card__agent-msg">
                    <span className="design-ref-card__agent-msg-icon">
                      <CommentIcon />
                    </span>
                    <span>
                      Should we use the new design tokens or keep the existing palette for backward
                      compat?
                    </span>
                  </div>
                  <a href="#context" className="design-ref-card__view-context">
                    View current context →
                  </a>
                  <div className="design-ref-card__presets">
                    <button className="design-ref-card__preset" type="button">Continue</button>
                    <button className="design-ref-card__preset" type="button">Abort</button>
                    <button className="design-ref-card__preset" type="button">Skip</button>
                  </div>
                  <div className="design-ref-card__reply-wrap">
                    <textarea
                      className="design-ref-card__reply"
                      rows={1}
                      placeholder="Type a reply… (⏎ to send)"
                    />
                  </div>
                  <div className="design-ref-card__footer">
                    <span className="design-ref-card__status">waiting_input</span>
                    <button className="design-ref-card__kill" type="button" title="Terminate session">
                      <TrashIcon />
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div className="design-ref-column">
              <div className="design-ref-col-head">
                <div className="design-ref-col-indicator design-ref-col-indicator--merge" />
                <span className="design-ref-col-head__label">Merge</span>
                <span className="design-ref-col-head__count">1</span>
              </div>
              <div className="design-ref-col-body">
                <div className="design-ref-card design-ref-card--merge">
                  <div className="design-ref-card__header">
                    <div className="design-ref-adot design-ref-adot--ready" />
                    <span className="design-ref-card__id">mno345</span>
                    <button type="button" className="design-ref-card__terminal">
                      <TerminalIcon />
                      terminal
                    </button>
                  </div>
                  <div className="design-ref-card__title-wrap">
                    <p className="design-ref-card__title">
                      Fix memory leak in background worker thread
                    </p>
                  </div>
                  <div className="design-ref-card__meta">
                    <span className="design-ref-meta-branch">fix/worker-memory…</span>
                    <span className="design-ref-meta-sep">·</span>
                    <a href="#pr-36" className="design-ref-meta-pr">#36</a>
                    <span className="design-ref-meta-diff">
                      <span className="design-ref-diff--add">+12</span>
                      <span className="design-ref-diff--del">-45</span>
                      <span className="design-ref-diff--size">XS</span>
                    </span>
                  </div>
                  <div className="design-ref-card__ci">
                    <span className="design-ref-ci-chip design-ref-ci-chip--pass">
                      <CheckIcon />
                      typecheck
                    </span>
                    <span className="design-ref-ci-chip design-ref-ci-chip--pass">
                      <CheckIcon />
                      tests (47)
                    </span>
                    <span className="design-ref-ci-chip design-ref-ci-chip--pass">
                      <CheckIcon />
                      build
                    </span>
                  </div>
                  <div className="design-ref-card__secondary design-ref-card__secondary--approved">
                    <span className="design-ref-card__secondary-icon">
                      <CheckIcon size={9} />
                    </span>
                    Approved by @sarah · ready to merge
                  </div>
                  <div className="design-ref-card__footer">
                    <span className="design-ref-card__status">mergeable</span>
                    <button className="design-ref-card__merge" type="button">
                      <MergeIcon />
                      Merge PR #36
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="design-system-subsection">
          <p className="design-system-subsection__label">Empty Dashboard Reference</p>
          <div className="design-system-board-sample">
            <EmptyState orchestratorHref="/orchestrators" />
          </div>
        </div>
      </section>

      <section id="done-sessions" className="design-system-section">
        <div className="design-system-section__head">
          <p className="design-system-section__eyebrow">Archive Pattern</p>
          <h2 className="design-system-section__title">Done / Terminated Reference</h2>
        </div>
        <div className="design-system-done-specimen">
          <div className="done-bar">
            <button type="button" className="done-bar__toggle" aria-expanded="true">
              <svg
                className="done-bar__chevron done-bar__chevron--open"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path d="m9 18 6-6-6-6" />
              </svg>
              <span className="done-bar__label">Done / Terminated</span>
              <span className="done-bar__count">3</span>
            </button>
            <div className="done-bar__cards">
              <div className="done-card">
                <p className="done-card__title">Stabilize dashboard loading states</p>
                <div className="done-card__meta">
                  <span className="done-card__badge done-card__badge--merged">merged</span>
                  <a href="#done-pr-37" className="done-card__pr">
                    <svg
                      width="9"
                      height="9"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      viewBox="0 0 24 24"
                    >
                      <circle cx="18" cy="18" r="3" />
                      <circle cx="6" cy="6" r="3" />
                      <path d="M6 9v3a6 6 0 0 0 6 6h3" />
                    </svg>
                    #37
                  </a>
                  <span className="done-card__age">2d ago</span>
                  <button type="button" className="done-card__restore">Restore</button>
                </div>
              </div>

              <div className="done-card">
                <p className="done-card__title">Fix runaway terminal reconnect loop</p>
                <div className="done-card__meta">
                  <span className="done-card__badge done-card__badge--terminated">terminated</span>
                  <span className="done-card__age">5h ago</span>
                  <button type="button" className="done-card__restore">Restore</button>
                </div>
              </div>

              <div className="done-card">
                <p className="done-card__title">Polish project sidebar hover hierarchy</p>
                <div className="done-card__meta">
                  <span className="done-card__badge done-card__badge--merged">merged</span>
                  <a href="#done-pr-41" className="done-card__pr">
                    <svg
                      width="9"
                      height="9"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      viewBox="0 0 24 24"
                    >
                      <circle cx="18" cy="18" r="3" />
                      <circle cx="6" cy="6" r="3" />
                      <path d="M6 9v3a6 6 0 0 0 6 6h3" />
                    </svg>
                    #41
                  </a>
                  <span className="done-card__age">1d ago</span>
                  <button type="button" className="done-card__restore">Restore</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="prs-page" className="design-system-section">
        <div className="design-system-section__head">
          <p className="design-system-section__eyebrow">Collection View</p>
          <h2 className="design-system-section__title">PRs Page Reference</h2>
        </div>
        <div className="design-system-prs-page">
          <div className="design-system-prs-page__hero">
            <div>
              <h3 className="design-system-prs-page__title">Agent Orchestrator PRs</h3>
              <p className="design-system-prs-page__subtitle">
                Review open, merged, and closed pull requests across the active project.
              </p>
            </div>
            <div className="design-system-prs-page__stats">
              <div className="design-system-prs-page__stat">
                <span className="design-system-prs-page__stat-value">3</span>
                <span className="design-system-prs-page__stat-label">Open PRs</span>
              </div>
              <div className="design-system-prs-page__stat">
                <span className="design-system-prs-page__stat-value">12</span>
                <span className="design-system-prs-page__stat-label">Merged</span>
              </div>
              <div className="design-system-prs-page__stat">
                <span className="design-system-prs-page__stat-value">1</span>
                <span className="design-system-prs-page__stat-label">Closed</span>
              </div>
            </div>
          </div>

          <div className="design-system-prs-page__filters">
            <span className="design-system-prs-page__filter design-system-prs-page__filter--active">
              All <span>16</span>
            </span>
            <span className="design-system-prs-page__filter">
              Open <span>3</span>
            </span>
            <span className="design-system-prs-page__filter">
              Merged <span>12</span>
            </span>
            <span className="design-system-prs-page__filter">
              Closed <span>1</span>
            </span>
          </div>

          <div className="design-system-prs-page__list">
            <div className="design-system-pr-card">
              <div className="design-system-pr-card__row">
                <a href="#pr-42" className="design-system-pr-card__title">
                  PR #42: Add dark mode support to design system tokens
                </a>
                <span className="design-system-pr-card__diff-stats">
                  <span className="design-ref-diff--add">+234</span>{" "}
                  <span className="design-ref-diff--del">-18</span>
                </span>
                <span className="design-system-pr-card__files">6 files</span>
              </div>
              <div className="design-system-pr-card__details">
                <span className="design-system-blocker-chip design-system-blocker-chip--fail">
                  ✕ 2 checks failing <span className="design-system-blocker-chip__note">· notified</span>
                </span>
                <span className="design-system-blocker-chip design-system-blocker-chip--fail">
                  ✕ Changes requested <span className="design-system-blocker-chip__note">· notified</span>
                </span>
                <span className="design-system-pr-card__sep" />
                <span className="design-system-ci-chip design-system-ci-chip--fail">✕ typecheck</span>
                <span className="design-system-ci-chip design-system-ci-chip--fail">✕ tests</span>
                <span className="design-system-ci-chip design-system-ci-chip--pass">✓ lint</span>
                <span className="design-system-ci-chip design-system-ci-chip--pass">✓ build</span>
              </div>
            </div>

            <div className="design-system-pr-card">
              <div className="design-system-pr-card__row">
                <a href="#pr-38" className="design-system-pr-card__title">
                  PR #38: Refactor API client to use fetch with retry logic
                </a>
                <span className="design-system-pr-card__diff-stats">
                  <span className="design-ref-diff--add">+89</span>{" "}
                  <span className="design-ref-diff--del">-156</span>
                </span>
                <span className="design-system-pr-card__files">2 files</span>
              </div>
              <div className="design-system-pr-card__details">
                <span className="design-system-prs-page__merge-banner">
                  <CheckIcon size={11} />
                  Ready to merge
                </span>
                <span className="design-system-pr-card__sep" />
                <span className="design-system-ci-chip design-system-ci-chip--pass">✓ typecheck</span>
                <span className="design-system-ci-chip design-system-ci-chip--pass">✓ tests (47)</span>
                <span className="design-system-ci-chip design-system-ci-chip--pass">✓ lint</span>
                <span className="design-system-ci-chip design-system-ci-chip--pass">✓ build</span>
              </div>
            </div>

            <div className="design-system-pr-card">
              <div className="design-system-pr-card__row">
                <a href="#pr-29" className="design-system-pr-card__title">
                  PR #29: Stabilize dashboard loading states
                </a>
                <span className="design-system-pr-card__diff-stats">
                  <span className="design-ref-diff--add">+84</span>{" "}
                  <span className="design-ref-diff--del">-21</span>
                </span>
                <span className="design-system-pr-card__files">3 files</span>
              </div>
              <div className="design-system-pr-card__details">
                <span className="design-system-ci-chip design-system-ci-chip--pass">✓ merged</span>
                <span className="design-system-pr-card__sep" />
                <span className="design-system-prs-page__muted-note">
                  Shipped to production 2 days ago
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="session-detail" className="design-system-section">
        <div className="design-system-section__head">
          <p className="design-system-section__eyebrow">Detail View</p>
          <h2 className="design-system-section__title">Session Detail Anatomy</h2>
        </div>
        <div className="design-system-detail-specimen design-system-detail-specimen--session-html">
          <div className="detail">
            <div className="crumbs">
              <a href="/" className="crumb-back">
                <svg fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path d="m15 18-6-6 6-6" />
                </svg>
                Dashboard
              </a>
              <span className="crumb-sep">/</span>
              <span className="crumb-id">abc123</span>
            </div>
            <div className="identity">
              <div className="identity__info">
                <h3 className="identity__title">Add dark mode support to design system tokens</h3>
                <div className="identity__pills">
                  <span className="status-pill status-pill--active">
                    <span className="status-pill__dot" />
                    Active
                  </span>
                  <a href="#branch" className="meta-pill meta-pill--branch">
                    feat/dark-mode-tokens
                  </a>
                  <a href="#pr-42" className="meta-pill meta-pill--pr">
                    PR #42
                  </a>
                  <span className="meta-pill meta-pill--diff">
                    <span className="diff--add">+234</span>
                    <span className="diff--del">-18</span>
                  </span>
                </div>
              </div>
              <div className="identity__actions">
                <button type="button" className="action-btn">
                  <CommentIcon />
                  Message
                </button>
                <button type="button" className="action-btn action-btn--danger">
                  <TrashIcon />
                  Kill
                </button>
              </div>
            </div>

            <div className="pr-card">
              <div className="pr-card__row">
                <a href="#pr-42" className="pr-card__title-link">
                  PR #42: Add dark mode support to design system tokens
                </a>
                <span className="pr-card__diff-stats">
                  <span className="diff--add">+234</span> <span className="diff--del">-18</span>
                </span>
                <span className="pr-card__diff-label">6 files</span>
              </div>
              <div className="pr-card__details">
                <span className="blocker-chip blocker-chip--fail">
                  ✕ 2 checks failing <span className="blocker-chip__note">· notified</span>
                </span>
                <span className="blocker-chip blocker-chip--fail">
                  ✕ Changes requested <span className="blocker-chip__note">· notified</span>
                </span>
                <span className="pr-sep" />
                <span className="ci-chip ci-chip--fail">✕ typecheck</span>
                <span className="ci-chip ci-chip--fail">✕ tests</span>
                <span className="ci-chip ci-chip--pass">✓ lint</span>
                <span className="ci-chip ci-chip--pass">✓ build</span>
              </div>
              <details className="comments-strip" open>
                <summary className="comments-strip__toggle">
                  <svg className="comments-strip__chevron" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                    <path d="M9 5l7 7-7 7" />
                  </svg>
                  <span className="comments-strip__label">Unresolved Comments</span>
                  <span className="count-badge">3</span>
                  <span className="comments-strip__hint">click to expand</span>
                </summary>
                <div className="comments-strip__body">
                  <details className="comment" open>
                    <summary className="comment__row">
                      <svg className="comment__chevron" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                        <path d="M9 5l7 7-7 7" />
                      </svg>
                      <span className="comment__title">Missing fallback for system preference</span>
                      <span className="comment__author">· @sarah</span>
                      <a href="#comment-1" className="comment__view">view →</a>
                    </summary>
                    <div className="comment__body">
                      <div className="comment__file">packages/web/src/theme/tokens.ts:42</div>
                      <p className="comment__text">
                        The dark mode toggle doesn&apos;t fall back to <code>prefers-color-scheme</code>.
                        Users without a preference get stuck on light mode.
                      </p>
                      <button type="button" className="comment__fix-btn">Ask Agent to Fix</button>
                    </div>
                  </details>
                  <details className="comment">
                    <summary className="comment__row">
                      <svg className="comment__chevron" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                        <path d="M9 5l7 7-7 7" />
                      </svg>
                      <span className="comment__title">Color contrast ratio too low</span>
                      <span className="comment__author">· @alex</span>
                      <a href="#comment-2" className="comment__view">view →</a>
                    </summary>
                  </details>
                  <details className="comment">
                    <summary className="comment__row">
                      <svg className="comment__chevron" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                        <path d="M9 5l7 7-7 7" />
                      </svg>
                      <span className="comment__title">Unused CSS custom properties</span>
                      <span className="comment__author">· @sarah</span>
                      <a href="#comment-3" className="comment__view">view →</a>
                    </summary>
                  </details>
                </div>
              </details>
            </div>

            <div className="terminal-wrap">
              <div className="section-label">
                <div className="section-label__bar" style={{ background: "var(--color-status-working)" }} />
                <span className="section-label__text">Live Terminal</span>
              </div>
              <div className="terminal-frame">
                <div className="terminal-frame__bar">
                  <div className="terminal-frame__bar-left">
                    <span className="terminal-frame__session-id">abc123</span>
                  </div>
                  <div className="terminal-frame__bar-right">
                    <button type="button" className="terminal-frame__btn" aria-label="Refresh terminal">
                      <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
                        <path d="M20 11a8 8 0 1 0 2.3 5.7M20 4v7h-7" />
                      </svg>
                    </button>
                    <button type="button" className="terminal-frame__btn" aria-label="Expand terminal">
                      <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
                        <path d="M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5" />
                      </svg>
                    </button>
                  </div>
                </div>
                <div className="terminal-body">
                  <p><span className="t-prompt">$</span> <span className="t-cmd">claude --resume</span></p>
                  <p className="t-dim">Resuming session abc123…</p>
                  <p>&nbsp;</p>
                  <p><span className="t-info">Claude</span> <span className="t-dim">Reading packages/web/src/theme/tokens.ts…</span></p>
                  <p><span className="t-info">Claude</span> <span className="t-dim">Analyzing existing color system…</span></p>
                  <p>&nbsp;</p>
                  <p><span className="t-info">Claude</span> I&apos;ll add dark mode variants for all design tokens.</p>
                  <p className="t-dim">This involves updating the theme object with dark/light mode mappings for each color category.</p>
                </div>
              </div>
            </div>

            <div className="scenario-sep"><span className="scenario-sep__label">Scenario 2 — Merge-ready</span></div>

            <div className="crumbs">
              <a href="/" className="crumb-back">
                <svg fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path d="m15 18-6-6 6-6" />
                </svg>
                Dashboard
              </a>
              <span className="crumb-sep">/</span>
              <span className="crumb-id">def456</span>
            </div>
            <div className="identity">
              <div className="identity__info">
                <h3 className="identity__title">Refactor API client to use fetch with retry logic</h3>
                <div className="identity__pills">
                  <span className="status-pill status-pill--ready">
                    <span className="status-pill__dot" />
                    Ready
                  </span>
                  <a href="#branch-2" className="meta-pill meta-pill--branch">refactor/api-client</a>
                  <a href="#pr-38" className="meta-pill meta-pill--pr">PR #38</a>
                  <span className="meta-pill meta-pill--diff">
                    <span className="diff--add">+89</span>
                    <span className="diff--del">-156</span>
                  </span>
                </div>
              </div>
              <div className="identity__actions">
                <button type="button" className="action-btn">
                  <CommentIcon />
                  Message
                </button>
                <button type="button" className="action-btn action-btn--danger">
                  <TrashIcon />
                  Kill
                </button>
              </div>
            </div>

            <div className="pr-card pr-card--green">
              <div className="pr-card__row">
                <a href="#pr-38" className="pr-card__title-link">
                  PR #38: Refactor API client to use fetch with retry logic
                </a>
                <span className="pr-card__diff-stats">
                  <span className="diff--add">+89</span> <span className="diff--del">-156</span>
                </span>
                <span className="pr-card__diff-label">2 files</span>
              </div>
              <div className="pr-card__details">
                <span className="merge-banner">
                  <CheckIcon size={11} />
                  Ready to merge
                </span>
                <span className="pr-sep" />
                <span className="ci-chip ci-chip--pass">✓ typecheck</span>
                <span className="ci-chip ci-chip--pass">✓ tests (47)</span>
                <span className="ci-chip ci-chip--pass">✓ lint</span>
                <span className="ci-chip ci-chip--pass">✓ build</span>
              </div>
            </div>

            <div className="terminal-wrap">
              <div className="section-label">
                <div className="section-label__bar" style={{ background: "var(--color-status-merge)" }} />
                <span className="section-label__text">Live Terminal</span>
              </div>
              <div className="terminal-frame">
                <div className="terminal-frame__bar">
                  <div className="terminal-frame__bar-left">
                    <span className="terminal-frame__session-id">def456</span>
                  </div>
                </div>
                <div className="terminal-body terminal-body--compact">
                  <p><span className="t-info">Claude</span> All changes are complete. Here&apos;s a summary:</p>
                  <p>&nbsp;</p>
                  <p><span className="t-ok">Edit</span> packages/web/src/lib/api-client.ts <span className="t-dim">(+89, -156)</span></p>
                  <p><span className="t-ok">Edit</span> packages/web/src/lib/__tests__/api-client.test.ts <span className="t-dim">(+47, -23)</span></p>
                  <p>&nbsp;</p>
                  <p><span className="t-prompt">$</span> <span className="t-cmd">pnpm --filter @composio/ao-web test</span></p>
                  <p><span className="t-ok">PASS</span> <span className="t-dim">packages/web/src/lib/__tests__/api-client.test.ts (47 tests)</span></p>
                  <p><span className="t-info">Claude</span> All CI checks are passing and the PR has been approved.</p>
                </div>
              </div>
            </div>

            <div className="scenario-sep"><span className="scenario-sep__label">Scenario 3 — Waiting for input</span></div>

            <div className="crumbs">
              <a href="/" className="crumb-back">
                <svg fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path d="m15 18-6-6 6-6" />
                </svg>
                Dashboard
              </a>
              <span className="crumb-sep">/</span>
              <span className="crumb-id">xyz789</span>
            </div>
            <div className="identity">
              <div className="identity__info">
                <h3 className="identity__title">Update onboarding flow with compliance checks</h3>
                <div className="identity__pills">
                  <span className="status-pill status-pill--waiting">
                    <span className="status-pill__dot" />
                    Waiting for input
                  </span>
                  <a href="#branch-3" className="meta-pill meta-pill--branch">feat/onboarding-compliance</a>
                  <a href="#pr-55" className="meta-pill meta-pill--pr">PR #55</a>
                  <span className="meta-pill meta-pill--diff">
                    <span className="diff--add">+312</span>
                    <span className="diff--del">-45</span>
                  </span>
                </div>
              </div>
              <div className="identity__actions">
                <button type="button" className="action-btn">
                  <CommentIcon />
                  Message
                </button>
                <button type="button" className="action-btn action-btn--danger">
                  <TrashIcon />
                  Kill
                </button>
              </div>
            </div>

            <div className="pr-card">
              <div className="pr-card__row">
                <a href="#pr-55" className="pr-card__title-link">
                  PR #55: Update onboarding flow with compliance checks
                </a>
                <span className="pr-card__diff-stats">
                  <span className="diff--add">+312</span> <span className="diff--del">-45</span>
                </span>
                <span className="pr-card__diff-label">Draft</span>
              </div>
              <div className="pr-card__details">
                <span className="blocker-chip blocker-chip--warn">● CI pending</span>
                <span className="blocker-chip blocker-chip--muted">○ Awaiting reviewer</span>
                <span className="blocker-chip blocker-chip--muted">○ Draft</span>
                <span className="pr-sep" />
                <span className="ci-chip ci-chip--pending">● typecheck</span>
                <span className="ci-chip ci-chip--queued">○ tests</span>
                <span className="ci-chip ci-chip--queued">○ build</span>
              </div>
            </div>

            <div className="terminal-wrap">
              <div className="section-label">
                <div className="section-label__bar" style={{ background: "var(--color-status-respond)" }} />
                <span className="section-label__text">Live Terminal</span>
              </div>
              <div className="terminal-frame">
                <div className="terminal-frame__bar">
                  <div className="terminal-frame__bar-left">
                    <span className="terminal-frame__session-id">xyz789</span>
                  </div>
                </div>
                <div className="terminal-body terminal-body--short">
                  <p><span className="t-info">Claude</span> I need to run database migrations for the new</p>
                  <p className="t-dim">compliance_checks table. This will modify the schema.</p>
                  <p>&nbsp;</p>
                  <p className="t-warn">Permission request</p>
                  <p>Run: <span className="t-cmd">pnpm db:migrate:dev</span></p>
                  <p className="t-dim">[y/n]</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
