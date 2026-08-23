import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AlertCircle, ArrowRight, RefreshCw, Settings } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { OrchestratorIcon } from "../components/icons";
import { SessionView } from "../components/SessionView";
import {
  useWorkspaceQuery,
  workspaceQueryKey,
} from "../hooks/useWorkspaceQuery";
import {
  latestProjectOrchestrator,
  orchestratorLaunchEffect,
  orchestratorLaunchIntent,
  orchestratorState,
  orchestratorWorkers,
} from "../lib/orchestrator-state";
import { restartProjectOrchestrator } from "../lib/restart-orchestrator";
import {
  chatPreflightGuidance,
  isChatPreflightError,
  spawnOrchestrator,
} from "../lib/spawn-orchestrator";
import { getAgentActivityView } from "../lib/session-presentation";
import { cn } from "../lib/utils";
import { useUiStore } from "../stores/ui-store";
import { hasConfiguredOrchestratorAgent } from "../types/workspace";

export const Route = createFileRoute(
  "/_shell/projects/$projectId_/orchestrator",
)({
  component: ProjectOrchestratorRoute,
});

export function ProjectOrchestratorRoute() {
	const { t } = useTranslation();
  const { projectId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const workspaceQuery = useWorkspaceQuery();
  const workspace = workspaceQuery.data?.find(
    (candidate) => candidate.id === projectId,
  );
  const orchestrator = latestProjectOrchestrator(workspace?.sessions ?? []);
  const state = orchestratorState(orchestrator);
  const intent = orchestratorLaunchIntent(state);
  const workers = orchestratorWorkers(workspace?.sessions ?? [], projectId);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [isLaunching, setIsLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<unknown>();
  const restartingProjectIds = useUiStore(
    (store) => store.restartingProjectIds,
  );
  const setProjectRestarting = useUiStore(
    (store) => store.setProjectRestarting,
  );
  const setOrchestratorReplacementError = useUiStore(
    (store) => store.setOrchestratorReplacementError,
  );
  const setOrchestratorStartupError = useUiStore(
    (store) => store.setOrchestratorStartupError,
  );
  const startupError = useUiStore(
    (store) => store.orchestratorStartupErrors[projectId],
  );
  const isRestarting = restartingProjectIds.has(projectId);
  const busy = isLaunching || isRestarting;

  useEffect(() => {
    setLaunchError(undefined);
    setConfirmRestart(false);
  }, [projectId]);

  useEffect(() => {
    if (state === "running" && startupError)
      setOrchestratorStartupError(projectId, null);
  }, [projectId, setOrchestratorStartupError, startupError, state]);

  const openSettings = () =>
    useUiStore.getState().openProjectSettings(projectId);

  const launch = async (clean: boolean) => {
    if (orchestratorLaunchEffect(state, clean) === "no_op") return;
    setLaunchError(undefined);
    setOrchestratorStartupError(projectId, null);
    if (clean) {
      await restartProjectOrchestrator({
        projectId,
        queryClient,
        navigate,
        setProjectRestarting,
        setOrchestratorReplacementError,
        onError: setLaunchError,
      });
      return;
    }

    setIsLaunching(true);
    try {
      await spawnOrchestrator(projectId, "orchestrator_route", false, "chat");
      await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
    } catch (error) {
      setLaunchError(error);
    } finally {
      setIsLaunching(false);
    }
  };

  const requestLaunch = () => {
    if (intent.confirm) {
      setConfirmRestart(true);
      return;
    }
    void launch(intent.clean);
  };

  if (workspaceQuery.isLoading && !workspace) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center" role="status">
        <span className="text-sm text-muted-foreground">{t("orchestratorRoute.loading")}</span>
      </div>
    );
  }

  if (!workspace) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center px-6">
        <div className="max-w-md text-center">
          <h1 className="text-lg font-semibold text-foreground">
            {t("orchestratorRoute.projectUnavailable")}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("orchestratorRoute.projectUnavailableBody")}
          </p>
        </div>
      </div>
    );
  }

  const preflightGuidance = isChatPreflightError(launchError)
    ? chatPreflightGuidance(launchError.code)
    : undefined;
  const errorMessage =
    preflightGuidance ??
    (launchError instanceof Error ? launchError.message : undefined) ??
    startupError;
  const configured = hasConfiguredOrchestratorAgent(workspace);
  const activity =
    state === "running"
      ? getAgentActivityView(orchestrator?.activity)
      : undefined;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-orchestrator-state={state}
      data-testid="orchestrator-route"
    >
      {state === "running" && orchestrator ? (
        <>
          <section
            aria-label={t("orchestratorRoute.delegatedWorkers")}
            className="flex min-h-12 shrink-0 items-center gap-3 border-b border-border px-4"
            data-testid="orchestrator-workers"
          >
            <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto py-2">
              <span className="shrink-0 text-xs font-medium text-muted-foreground">
                {t("orchestratorRoute.workers")}
              </span>
              {workers.length === 0 ? (
                <span className="text-xs text-passive">
                  {t("orchestratorRoute.noDelegatedWorkers")}
                </span>
              ) : (
                workers.map((worker) => (
                  <button
                    key={worker.id}
                    className="inline-flex h-7 max-w-48 shrink-0 items-center gap-1.5 rounded-md bg-interactive-hover px-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
                    onClick={() =>
                      void navigate({
                        to: "/projects/$projectId/sessions/$sessionId",
                        params: { projectId, sessionId: worker.id },
                      })
                    }
                    type="button"
                  >
                    <span
                      className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        getAgentActivityView(worker.activity)
                          .indicatorClassName,
                      )}
                      aria-hidden="true"
                    />
                    <span className="truncate">{worker.title}</span>
                    <ArrowRight
                      className="size-3 shrink-0"
                      aria-hidden="true"
                    />
                  </button>
                ))
              )}
            </div>
            <button
              aria-label={t("orchestratorRoute.restart")}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground disabled:opacity-50"
              disabled={busy}
              onClick={requestLaunch}
              type="button"
            >
              <RefreshCw className="size-3.5" aria-hidden="true" />
              {busy ? t("orchestratorRoute.restarting") : t("orchestratorRoute.restart")}
            </button>
            <span className="sr-only">
              {t("orchestratorRoute.running", { activity: activity?.label ?? t("orchestratorRoute.online") })}
            </span>
          </section>
          <div className="min-h-0 flex-1">
            <SessionView sessionId={orchestrator.id} />
          </div>
        </>
      ) : (
        <div className="grid min-h-0 flex-1 place-items-center px-6 py-10">
          <section className="w-full max-w-xl rounded-xl border border-border bg-card p-8 text-center shadow-sm">
            <span className="mx-auto grid size-12 place-items-center rounded-xl bg-interactive-hover text-foreground">
              <OrchestratorIcon className="size-6" aria-hidden="true" />
            </span>
            <h1 className="mt-4 text-xl font-semibold text-foreground">
              {t("orchestratorRoute.title")}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {t("orchestratorRoute.description")}
            </p>
            <p className="mt-4 text-xs font-medium uppercase tracking-wide text-passive">
              {state === "stopped"
                ? t("orchestratorRoute.stopped")
                : t("orchestratorRoute.notStarted")}
            </p>
            {!configured ? (
              <div className="mt-5 rounded-lg border border-border bg-muted/30 p-4 text-left">
                <p className="text-sm font-medium text-foreground">
                  {t("orchestratorRoute.configureAgentTitle")}
                </p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {t("orchestratorRoute.configureAgentBody")}
                </p>
              </div>
            ) : null}
            {errorMessage ? (
              <div
                className="mt-5 flex gap-2 rounded-lg border border-error/30 bg-error/5 p-3 text-left"
                role="alert"
              >
                <AlertCircle
                  className="mt-0.5 size-4 shrink-0 text-error"
                  aria-hidden="true"
                />
                <p className="text-xs leading-5 text-error">{errorMessage}</p>
              </div>
            ) : null}
            <div className="mt-6 flex flex-wrap justify-center gap-2">
              {configured ? (
                <button
                  className="inline-flex h-9 items-center rounded-md bg-accent px-4 text-sm font-medium text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
                  disabled={busy}
                  onClick={requestLaunch}
                  type="button"
                >
                  {busy
                    ? t("orchestratorRoute.starting")
                    : intent.confirm
                      ? t("orchestratorRoute.restart")
                      : t("orchestratorRoute.start")}
                </button>
              ) : null}
              <button
                className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border px-4 text-sm font-medium text-foreground transition-colors hover:bg-interactive-hover"
                onClick={openSettings}
                type="button"
              >
                <Settings className="size-4" aria-hidden="true" />
                {t("orchestratorRoute.projectSettings")}
              </button>
            </div>
          </section>
        </div>
      )}
      <ConfirmDialog
        confirmLabel={t("orchestratorRoute.restart")}
        description={t("orchestratorRoute.confirmRestartDescription")}
        destructive
        onConfirm={() => {
          setConfirmRestart(false);
          void launch(true);
        }}
        onOpenChange={setConfirmRestart}
        open={confirmRestart}
        title={t("orchestratorRoute.confirmRestartTitle")}
      />
    </div>
  );
}
