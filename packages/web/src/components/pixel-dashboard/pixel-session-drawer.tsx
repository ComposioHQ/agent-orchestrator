import { useEffect, useMemo, useState } from "react";
import { buildDashboardHref } from "@/lib/dashboard-route-state";
import { type DashboardSession, isPRRateLimited } from "@/lib/types";
import {
  getSessionActionConfidence,
  getSessionActionAvailability,
  getSessionAlerts,
} from "../session-actions";
import type { DashboardTrust, ProjectOverview } from "../Dashboard";
import { PRInspectionSummary, SessionInspectionSummary } from "../session-inspection";

interface PixelSessionDrawerContentProps {
  allProjectsView: boolean;
  dashboardTrust: DashboardTrust;
  onKill: (sessionId: string) => Promise<unknown>;
  onMerge: (prNumber: number) => Promise<unknown>;
  onRestore: (sessionId: string) => Promise<unknown>;
  onSend: (sessionId: string, message: string) => Promise<unknown>;
  projectOverview?: ProjectOverview | null;
  selectedSession: DashboardSession;
}

export function PixelSessionDrawerContent({
  allProjectsView,
  dashboardTrust,
  onKill,
  onMerge,
  onRestore,
  onSend,
  projectOverview,
  selectedSession,
}: PixelSessionDrawerContentProps) {
  const [selectedQuickMessage, setSelectedQuickMessage] = useState<string | null>(null);
  const [customMessage, setCustomMessage] = useState("");
  const [pendingAction, setPendingAction] = useState<"send" | "kill" | "restore" | "merge" | null>(
    null,
  );
  const [confirmationAction, setConfirmationAction] = useState<"kill" | "merge" | null>(null);
  const [feedback, setFeedback] = useState<{ tone: "success" | "error"; message: string } | null>(
    null,
  );
  const projectScopedPixelHref = buildDashboardHref("/", {
    project: selectedSession.projectId,
    view: "pixel",
  });
  const availability = getSessionActionAvailability(selectedSession);
  const quickMessages = useMemo(
    () =>
      getSessionAlerts(selectedSession).filter(
        (alert): alert is typeof alert & { actionMessage: string } => typeof alert.actionMessage === "string",
      ),
    [selectedSession],
  );
  const sendMessage = customMessage.trim() || selectedQuickMessage?.trim() || "";
  const actionConfidence = useMemo(
    () =>
      getSessionActionConfidence(selectedSession, {
        alignment: dashboardTrust.alignment,
        paused: dashboardTrust.paused,
      }),
    [dashboardTrust.alignment, dashboardTrust.paused, selectedSession],
  );
  const primaryAction = availability.canMerge
    ? "merge"
    : availability.canRestore
      ? "restore"
      : availability.canSend
        ? "send"
        : availability.canKill
          ? "kill"
          : null;

  useEffect(() => {
    setSelectedQuickMessage(null);
    setCustomMessage("");
    setPendingAction(null);
    setConfirmationAction(null);
    setFeedback(null);
  }, [selectedSession.id]);

  async function runAction(
    action: "send" | "kill" | "restore" | "merge",
    runner: () => Promise<unknown>,
    successMessage: string,
  ) {
    setPendingAction(action);
    setFeedback(null);
    try {
      await runner();
      setFeedback({ tone: "success", message: successMessage });
      if (action === "send") {
        setCustomMessage("");
        setSelectedQuickMessage(null);
      }
      setConfirmationAction(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : `Failed to ${action}`;
      setFeedback({ tone: "error", message });
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <div className="space-y-4">
      <section className="rounded-[14px] border border-[var(--color-border-subtle)] bg-[rgba(15,23,42,0.86)] p-4 text-[var(--color-text-primary)]">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--color-text-tertiary)]">
              Session actions
            </div>
            <div className="mt-1 text-[12px] text-[var(--color-text-muted)]">
              Operate on <span className="font-semibold text-[var(--color-text-primary)]">{selectedSession.id}</span> without leaving the drawer.
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <ActionButton
              disabled={!availability.canSend || sendMessage.length === 0 || pendingAction !== null}
              emphasis={primaryAction === "send" ? "primary" : "secondary"}
              label={pendingAction === "send" ? "Sending..." : "Send"}
              onClick={() =>
                void runAction(
                  "send",
                  () => onSend(selectedSession.id, sendMessage),
                  `Message sent to ${selectedSession.id}`,
                )
              }
            />
            <ActionButton
              disabled={!availability.canRestore || pendingAction !== null}
              emphasis={primaryAction === "restore" ? "primary" : "secondary"}
              label={pendingAction === "restore" ? "Restoring..." : "Restore"}
              onClick={() =>
                void runAction(
                  "restore",
                  () => onRestore(selectedSession.id),
                  `Restore started for ${selectedSession.id}`,
                )
              }
            />
            <ActionButton
              destructive
              disabled={!availability.canKill || pendingAction !== null}
              emphasis={primaryAction === "kill" ? "primary" : "secondary"}
              label={confirmationAction === "kill" ? "Confirm kill" : "Kill"}
              onClick={() =>
                confirmationAction === "kill"
                  ? void runAction(
                      "kill",
                      () => onKill(selectedSession.id),
                      `${selectedSession.id} terminated`,
                    )
                  : setConfirmationAction("kill")
              }
            />
            <ActionButton
              disabled={!availability.canMerge || pendingAction !== null}
              emphasis={primaryAction === "merge" ? "primary" : "secondary"}
              label={confirmationAction === "merge" ? "Confirm merge" : "Merge"}
              onClick={() =>
                confirmationAction === "merge" && selectedSession.pr
                  ? void runAction(
                      "merge",
                      () => onMerge(selectedSession.pr!.number),
                      `PR #${selectedSession.pr!.number} merged`,
                    )
                  : setConfirmationAction("merge")
              }
            />
          </div>
        </div>

        <div
          className={
            actionConfidence.tone === "degraded"
              ? "mt-4 rounded-[12px] border border-[rgba(245,158,11,0.28)] bg-[rgba(120,53,15,0.18)] px-3 py-2 text-[12px] text-[rgba(253,230,138,0.96)]"
              : "mt-4 rounded-[12px] border border-[rgba(96,165,250,0.24)] bg-[rgba(30,41,59,0.3)] px-3 py-2 text-[12px] text-[rgba(191,219,254,0.92)]"
          }
        >
          {actionConfidence.label}
        </div>

        {quickMessages.length > 0 ? (
          <div className="mt-4">
            <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--color-text-tertiary)]">
              Quick prompts
            </div>
            <div className="flex flex-wrap gap-2">
              {quickMessages.map((alert) => (
                <button
                  key={alert.key}
                  type="button"
                  aria-pressed={selectedQuickMessage === alert.actionMessage}
                  onClick={() => {
                    setSelectedQuickMessage(alert.actionMessage);
                    setCustomMessage("");
                    setConfirmationAction(null);
                    setFeedback(null);
                  }}
                  className="rounded-[999px] border border-[rgba(148,163,184,0.28)] px-3 py-1.5 text-[11px] font-semibold text-[var(--color-text-secondary)] transition-colors aria-pressed:border-[var(--color-accent)] aria-pressed:bg-[rgba(59,130,246,0.16)] aria-pressed:text-[var(--color-text-primary)]"
                >
                  {alert.actionLabel}: {alert.label}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="mt-4 space-y-2">
          <label className="block text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--color-text-tertiary)]" htmlFor={`pixel-send-${selectedSession.id}`}>
            Send message
          </label>
          <textarea
            id={`pixel-send-${selectedSession.id}`}
            value={customMessage}
            onChange={(event) => {
              setCustomMessage(event.target.value);
              setFeedback(null);
              if (event.target.value.trim().length > 0) {
                setSelectedQuickMessage(null);
              }
            }}
            placeholder="Type a short operator instruction"
            rows={3}
            className="w-full rounded-[12px] border border-[var(--color-border-subtle)] bg-[rgba(15,23,42,0.72)] px-3 py-2 text-[13px] text-[var(--color-text-primary)] outline-none transition focus:border-[var(--color-accent)]"
          />
          <div className="text-[11px] text-[var(--color-text-muted)]">
            {sendMessage.length > 0
              ? `Ready to send: ${sendMessage}`
              : "Pick a quick prompt or enter a message to enable send."}
          </div>
        </div>

        {confirmationAction ? (
          <div className="mt-4 flex flex-wrap items-center gap-2 rounded-[12px] border border-[rgba(245,158,11,0.3)] bg-[rgba(120,53,15,0.26)] px-3 py-2 text-[12px] text-[rgba(253,230,138,0.96)]">
            <span>
              {confirmationAction === "merge"
                ? "Confirm merge for the selected PR."
                : "Confirm termination for the selected session."}
            </span>
            <button
              type="button"
              onClick={() => setConfirmationAction(null)}
              className="rounded border border-[rgba(253,230,138,0.32)] px-2 py-1 text-[11px] font-semibold text-[rgba(253,230,138,0.96)]"
            >
              Cancel
            </button>
          </div>
        ) : null}

        {selectedSession.pr && isPRRateLimited(selectedSession.pr) ? (
          <div className="mt-4 rounded-[12px] border border-[rgba(148,163,184,0.22)] bg-[rgba(15,23,42,0.58)] px-3 py-2 text-[12px] text-[var(--color-text-muted)]">
            PR enrichment is rate-limited, so merge stays disabled until fresh PR state is available.
          </div>
        ) : null}

        {feedback ? (
          <div
            className={
              feedback.tone === "success"
                ? "mt-4 rounded-[12px] border border-[rgba(34,197,94,0.28)] bg-[rgba(21,128,61,0.18)] px-3 py-2 text-[12px] text-[rgba(187,247,208,0.98)]"
                : "mt-4 rounded-[12px] border border-[rgba(239,68,68,0.28)] bg-[rgba(127,29,29,0.18)] px-3 py-2 text-[12px] text-[rgba(254,202,202,0.98)]"
            }
            role="status"
          >
            {feedback.message}
          </div>
        ) : null}
      </section>

      {allProjectsView && projectOverview ? (
        <section className="rounded-[14px] border border-[var(--color-border-subtle)] bg-[rgba(15,23,42,0.7)] p-4 text-[var(--color-text-primary)]">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--color-text-tertiary)]">
                Project context
              </div>
              <h3 className="mt-1 text-[15px] font-semibold">{projectOverview.project.name}</h3>
              <p className="mt-1 text-[12px] text-[var(--color-text-muted)]">
                {projectOverview.sessionCount} active session{projectOverview.sessionCount === 1 ? "" : "s"} ·{" "}
                {projectOverview.openPRCount} open PR
              </p>
            </div>
            <a
              href={projectScopedPixelHref}
              className="rounded-[8px] border border-[rgba(148,163,184,0.28)] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-[rgba(191,219,254,0.9)] hover:no-underline"
            >
              Open district
            </a>
          </div>
          <div className="mt-3 text-[11px] text-[var(--color-text-muted)]">
            {projectOverview.orchestrator ? "District orchestrator online" : "No district orchestrator"}
          </div>
        </section>
      ) : null}

      <section className="rounded-[14px] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--color-text-tertiary)]">
            Selected session
          </div>
          <a
            href={`/sessions/${encodeURIComponent(selectedSession.id)}`}
            className="text-[11px] font-semibold text-[var(--color-accent)] hover:underline"
          >
            Open full session
          </a>
        </div>
        <SessionInspectionSummary
          alignment={dashboardTrust.alignment}
          compact
          paused={dashboardTrust.paused}
          session={selectedSession}
        />
      </section>

      {selectedSession.pr ? (
        <details className="rounded-[14px] border border-[var(--color-border-subtle)] bg-[rgba(15,23,42,0.72)] p-0">
          <summary className="cursor-pointer list-none px-4 py-3 text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--color-text-tertiary)]">
            PR trust details
          </summary>
          <div className="px-4 pb-4">
            <PRInspectionSummary compact pr={selectedSession.pr} />
          </div>
        </details>
      ) : null}
    </div>
  );
}

function ActionButton({
  destructive = false,
  disabled,
  emphasis,
  label,
  onClick,
}: {
  destructive?: boolean;
  disabled: boolean;
  emphasis: "primary" | "secondary";
  label: string;
  onClick: () => void;
}) {
  const toneClass = destructive
    ? emphasis === "primary"
      ? "border-[rgba(248,113,113,0.55)] bg-[rgba(185,28,28,0.9)] text-white"
      : "border-[rgba(248,113,113,0.35)] text-[rgba(252,165,165,0.96)]"
    : emphasis === "primary"
      ? "border-[rgba(96,165,250,0.45)] bg-[rgba(37,99,235,0.85)] text-white"
      : "border-[rgba(148,163,184,0.28)] text-[var(--color-text-secondary)]";

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`rounded-[10px] border px-3 py-2 text-[12px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-45 ${toneClass}`}
    >
      {label}
    </button>
  );
}
