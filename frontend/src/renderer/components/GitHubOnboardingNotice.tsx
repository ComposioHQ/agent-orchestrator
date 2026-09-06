import { GitPullRequest, TerminalSquare, X } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { TerminalSessionState } from "../hooks/useTerminalSession";
import { useCloseShellTerminal } from "../hooks/useShellTerminals";
import { useGitHubAuthRequirement, useGitHubAuthTerminal, useStartGitHubAuthTerminal, useSystemRequirementsGate } from "../hooks/useSystemRequirementsGate";
import { aoBridge } from "../lib/bridge";
import { useShellMaybe } from "../lib/shell-context";
import { useResolvedTheme } from "../stores/ui-store";
import { TerminalPane } from "./TerminalPane";

const GITHUB_CLI_INSTALL_URL = "https://cli.github.com/";
const automaticallyChecked = new Set<string>();

/** Onboarding advisory. GitHub is not required for local work, but surfacing
 * missing auth before task creation prevents a late PR-creation failure inside
 * an agent session. */
export function GitHubOnboardingNotice() {
	const { t } = useTranslation();
	const gate = useSystemRequirementsGate();
	const authQuery = useGitHubAuthRequirement();
	const startLogin = useStartGitHubAuthTerminal();
	const terminalQuery = useGitHubAuthTerminal();
	const { mutate: closeTerminal } = useCloseShellTerminal();
	const theme = useResolvedTheme();
	const shell = useShellMaybe();
	const requirements = gate.requirements ?? [];
	const terminal = terminalQuery.data;
	const terminalRef = useRef(terminal);
	const refetchAuthRef = useRef(authQuery.refetch);
	const automaticLoginStartedRef = useRef(false);
	const gh = requirements.find((requirement) => requirement.id === "gh");
	const auth = authQuery.data;

	terminalRef.current = terminal;
	refetchAuthRef.current = authQuery.refetch;
	const handleTerminalState = useCallback((state: TerminalSessionState) => {
		const active = terminalRef.current;
		if (!active || (state !== "exited" && state !== "error")) return;
		if (automaticallyChecked.has(active.handleId)) return;
		automaticallyChecked.add(active.handleId);
		void refetchAuthRef.current();
	}, []);
	useEffect(() => {
		if (!auth?.satisfied || !terminal) return;
		closeTerminal(terminal.handleId, { onSettled: terminalQuery.clear });
	}, [auth?.satisfied, closeTerminal, terminal, terminalQuery.clear]);
	useEffect(() => {
		if (
			!auth ||
			auth.satisfied ||
			gh?.satisfied !== true ||
			terminal ||
			startLogin.isPending ||
			automaticLoginStartedRef.current
		) {
			return;
		}
		automaticLoginStartedRef.current = true;
		startLogin.mutate();
	}, [auth, gh?.satisfied, startLogin.isPending, startLogin.mutate, terminal]);

	if (!auth || auth.satisfied) return null;

	const openLogin = () => {
		startLogin.mutate();
	};

	const checkAgain = async () => {
		await authQuery.refetch();
	};
	const closeLogin = () => {
		if (!terminal) return;
		closeTerminal(terminal.handleId, { onSettled: terminalQuery.clear });
	};
	const cliMissing = gh?.satisfied === false;
	const checking = authQuery.isFetching;
	return (
		<div className="flex w-full justify-center px-3">
			<div className="w-full max-w-[620px] rounded-lg border border-warning/30 bg-warning/10 px-4 py-3" role="status">
				<div className="flex items-start gap-3">
					<GitPullRequest className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden="true" />
					<div className="min-w-0 flex-1">
						<p className="text-[14px] font-medium text-foreground">{t("startup.githubSetupTitle")}</p>
						<p className="mt-0.5 text-[12px] leading-5 text-muted-foreground">
							{t(cliMissing ? "startup.githubSetupMissingCli" : "startup.githubSetupSignedOut")}
						</p>
						<div className="mt-2 flex flex-wrap items-center gap-2">
							<button
								type="button"
								className="settings-footer-button settings-footer-button-primary"
								disabled={!cliMissing && (startLogin.isPending || Boolean(terminal))}
								onClick={() => cliMissing ? void aoBridge.app.openExternal(GITHUB_CLI_INSTALL_URL) : openLogin()}
							>
								{cliMissing ? null : <TerminalSquare className="size-icon-sm" aria-hidden="true" />}
								{cliMissing
									? t("startup.openGithubCliDocs")
									: startLogin.isPending
										? t("startup.githubLoginStarting")
										: t("startup.githubLogin")}
							</button>
							<button
								type="button"
								className="settings-footer-button"
								disabled={checking}
								onClick={() => void checkAgain()}
							>
								{checking ? t("startup.checkingAgain") : t("startup.checkAgain")}
							</button>
						</div>
						{startLogin.isError ? <p className="mt-2 text-xs text-destructive" role="alert">{startLogin.error.message}</p> : null}
						{terminal ? (
							<div className="mt-3 overflow-hidden rounded-md border border-border bg-terminal" data-testid="github-auth-terminal">
								<div className="flex min-h-9 items-center justify-between gap-3 border-b border-border bg-surface/90 px-3 py-1.5">
									<div className="min-w-0">
										<p className="truncate text-xs font-medium text-foreground">{terminal.title}</p>
										<p className="truncate text-[11px] text-muted-foreground">{t("startup.githubLoginRunning")}</p>
									</div>
									<button type="button" aria-label={t("common.close")} className="grid size-7 shrink-0 place-items-center rounded text-muted-foreground hover:bg-interactive-hover hover:text-foreground" onClick={closeLogin}>
										<X className="size-4" aria-hidden="true" />
									</button>
								</div>
								<div className="h-[240px] min-h-0">
									<TerminalPane daemonReady={shell ? shell.daemonStatus.state === "ready" : true} focusRequested fontSize={12} onTerminalStateChange={handleTerminalState} terminalTarget={{ kind: "shell", handleId: terminal.handleId, generation: terminal.createdAt, title: terminal.title }} theme={theme} />
								</div>
							</div>
						) : null}
					</div>
				</div>
			</div>
		</div>
	);
}
