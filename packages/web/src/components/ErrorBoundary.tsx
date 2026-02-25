"use client";

import { Component, type ReactNode } from "react";

interface ErrorReport {
  title: string;
  description: string;
  projectId: string;
  autoFix: boolean;
}

interface ReportResult {
  issue?: { id: string; url: string; title: string };
  sessionId?: string | null;
  warning?: string;
  error?: string;
}

type ReportState = "idle" | "reporting" | "success" | "error";

interface Props {
  children: ReactNode;
  /** The project ID to file issues against (e.g., "agent-orchestrator"). */
  selfProjectId: string;
}

interface State {
  error: Error | null;
  errorInfo: { componentStack?: string } | null;
  reportState: ReportState;
  result: ReportResult | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, errorInfo: null, reportState: "idle", result: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: { componentStack?: string }) {
    this.setState({ errorInfo });
    console.error("[ErrorBoundary]", error, errorInfo);
  }

  private buildIssueBody(): { title: string; description: string } {
    const { error, errorInfo } = this.state;
    if (!error) return { title: "Unknown error", description: "" };

    const title = `[Dashboard Bug] ${error.message.slice(0, 120)}`;

    const lines: string[] = [
      "## Error",
      "",
      "```",
      error.message,
      "```",
      "",
    ];

    if (error.stack) {
      lines.push("## Stack Trace", "", "```", error.stack, "```", "");
    }

    if (errorInfo?.componentStack) {
      lines.push(
        "## Component Stack",
        "",
        "```",
        errorInfo.componentStack.trim(),
        "```",
        "",
      );
    }

    lines.push(
      "## Environment",
      "",
      `- **URL**: \`${typeof window !== "undefined" ? window.location.href : "unknown"}\``,
      `- **User Agent**: \`${typeof navigator !== "undefined" ? navigator.userAgent : "unknown"}\``,
      `- **Timestamp**: ${new Date().toISOString()}`,
      "",
      "---",
      "*Auto-reported from the Agent Orchestrator dashboard.*",
    );

    return { title, description: lines.join("\n") };
  }

  private handleReport = async (autoFix: boolean) => {
    this.setState({ reportState: "reporting", result: null });
    const { title, description } = this.buildIssueBody();
    const payload: ErrorReport = {
      title,
      description,
      projectId: this.props.selfProjectId,
      autoFix,
    };

    try {
      const res = await fetch("/api/issues/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data: ReportResult = await res.json();
      if (!res.ok) {
        this.setState({ reportState: "error", result: data });
      } else {
        this.setState({ reportState: "success", result: data });
      }
    } catch (err) {
      this.setState({
        reportState: "error",
        result: { error: err instanceof Error ? err.message : "Network error" },
      });
    }
  };

  private handleRetry = () => {
    this.setState({ error: null, errorInfo: null, reportState: "idle", result: null });
  };

  render() {
    if (!this.state.error) return this.props.children;

    const { error, reportState, result } = this.state;

    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--color-bg-base)] px-6">
        <div className="w-full max-w-[560px]">
          {/* Error card */}
          <div
            className="overflow-hidden rounded-[8px] border border-[rgba(248,81,73,0.3)]"
            style={{ background: "linear-gradient(175deg, rgba(32,41,53,1) 0%, rgba(22,28,37,1) 100%)" }}
          >
            {/* Header */}
            <div className="border-b border-[var(--color-border-subtle)] px-5 py-4">
              <div className="flex items-center gap-2.5">
                <div className="flex h-6 w-6 items-center justify-center rounded-full bg-[rgba(248,81,73,0.15)]">
                  <svg className="h-3.5 w-3.5 text-[var(--color-status-error)]" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M15 9l-6 6M9 9l6 6" />
                  </svg>
                </div>
                <h1 className="text-[15px] font-semibold text-[var(--color-text-primary)]">
                  Dashboard Error
                </h1>
              </div>
            </div>

            {/* Body */}
            <div className="px-5 py-4">
              {/* Error message */}
              <div className="mb-4 rounded-[5px] border border-[var(--color-border-subtle)] bg-[rgba(0,0,0,0.2)] px-3.5 py-2.5">
                <p className="font-[var(--font-mono)] text-[12px] leading-relaxed text-[var(--color-status-error)]">
                  {error.message}
                </p>
              </div>

              {/* Stack trace (collapsed) */}
              {error.stack && (
                <details className="group mb-4">
                  <summary className="cursor-pointer text-[11px] font-medium text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]">
                    <svg
                      className="mr-1 inline h-3 w-3 transition-transform group-open:rotate-90"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      viewBox="0 0 24 24"
                    >
                      <path d="M9 5l7 7-7 7" />
                    </svg>
                    Stack trace
                  </summary>
                  <pre className="mt-2 max-h-[200px] overflow-auto rounded-[4px] border border-[var(--color-border-subtle)] bg-[rgba(0,0,0,0.2)] p-3 font-[var(--font-mono)] text-[10px] leading-relaxed text-[var(--color-text-muted)]">
                    {error.stack}
                  </pre>
                </details>
              )}

              {/* Success state */}
              {reportState === "success" && result?.issue && (
                <div className="mb-4 rounded-[5px] border border-[rgba(63,185,80,0.3)] bg-[rgba(63,185,80,0.08)] px-3.5 py-3">
                  <div className="flex items-center gap-2 text-[13px] font-semibold text-[var(--color-status-ready)]">
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                    Issue created & agent spawned
                  </div>
                  <div className="mt-2 space-y-1 text-[12px] text-[var(--color-text-secondary)]">
                    <p>
                      <a
                        href={result.issue.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[var(--color-accent)] hover:underline"
                      >
                        {result.issue.title}
                      </a>
                    </p>
                    {result.sessionId && (
                      <p>
                        Agent{" "}
                        <a
                          href={`/sessions/${encodeURIComponent(result.sessionId)}`}
                          className="text-[var(--color-accent)] hover:underline"
                        >
                          {result.sessionId}
                        </a>
                        {" "}is working on it.
                      </p>
                    )}
                    {result.warning && (
                      <p className="text-[var(--color-status-attention)]">{result.warning}</p>
                    )}
                  </div>
                </div>
              )}

              {/* Error state */}
              {reportState === "error" && result?.error && (
                <div className="mb-4 rounded-[5px] border border-[rgba(248,81,73,0.3)] bg-[rgba(248,81,73,0.08)] px-3.5 py-2.5 text-[12px] text-[var(--color-status-error)]">
                  Failed to report: {result.error}
                </div>
              )}

              {/* Actions */}
              <div className="flex flex-wrap items-center gap-2">
                {reportState !== "success" && (
                  <button
                    onClick={() => this.handleReport(true)}
                    disabled={reportState === "reporting"}
                    className="inline-flex items-center gap-2 rounded-[6px] bg-[var(--color-accent)] px-4 py-2 text-[13px] font-semibold text-white transition-all hover:brightness-110 disabled:opacity-50"
                  >
                    {reportState === "reporting" ? (
                      <>
                        <svg className="h-3.5 w-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                        Creating issue…
                      </>
                    ) : (
                      <>
                        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                          <path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                        </svg>
                        Report & Auto-Fix
                      </>
                    )}
                  </button>
                )}

                {reportState !== "success" && (
                  <button
                    onClick={() => this.handleReport(false)}
                    disabled={reportState === "reporting"}
                    className="rounded-[6px] border border-[var(--color-border-default)] px-4 py-2 text-[13px] text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text-primary)] disabled:opacity-50"
                  >
                    Report Only
                  </button>
                )}

                <button
                  onClick={this.handleRetry}
                  className="rounded-[6px] border border-[var(--color-border-default)] px-4 py-2 text-[13px] text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text-primary)]"
                >
                  Retry
                </button>
              </div>
            </div>
          </div>

          {/* Subtle footer */}
          <p className="mt-4 text-center text-[11px] text-[var(--color-text-tertiary)]">
            Clicking "Report & Auto-Fix" creates a GitHub issue and spawns an agent to fix it.
          </p>
        </div>
      </div>
    );
  }
}
