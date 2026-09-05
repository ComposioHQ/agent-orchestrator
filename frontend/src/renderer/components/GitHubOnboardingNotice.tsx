import { Check, Copy, GitPullRequest } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSystemRequirementsGate } from "../hooks/useSystemRequirementsGate";
import { aoBridge } from "../lib/bridge";

const GITHUB_CLI_INSTALL_URL = "https://cli.github.com/";
const GITHUB_LOGIN_COMMAND = "gh auth login";

/** Onboarding advisory. GitHub is not required for local work, but surfacing
 * missing auth before task creation prevents a late PR-creation failure inside
 * an agent session. */
export function GitHubOnboardingNotice() {
	const { t } = useTranslation();
	const gate = useSystemRequirementsGate();
	const requirements = gate.requirements ?? [];
	const [copied, setCopied] = useState(false);
	const [checking, setChecking] = useState(false);
	const resetTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
	const gh = requirements.find((requirement) => requirement.id === "gh");
	const auth = requirements.find((requirement) => requirement.id === "github-auth");

	useEffect(() => () => clearTimeout(resetTimer.current), []);

	if (!auth || auth.satisfied) return null;

	const copyLoginCommand = async () => {
		await aoBridge.clipboard.writeText(GITHUB_LOGIN_COMMAND);
		setCopied(true);
		clearTimeout(resetTimer.current);
		resetTimer.current = setTimeout(() => setCopied(false), 1_400);
	};

	const checkAgain = async () => {
		setChecking(true);
		try {
			await gate.query?.refetch();
		} finally {
			setChecking(false);
		}
	};

	const cliMissing = !gh?.satisfied;
	return (
		<div className="w-full max-w-[520px] rounded-lg border border-warning/30 bg-warning/10 px-4 py-3" role="status">
			<div className="flex items-start gap-3">
				<GitPullRequest className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden="true" />
				<div className="min-w-0 flex-1">
					<p className="text-[14px] font-medium text-foreground">{t("startup.githubSetupTitle")}</p>
					<p className="mt-0.5 text-[12px] leading-5 text-muted-foreground">
						{t(cliMissing ? "startup.githubSetupMissingCli" : "startup.githubSetupSignedOut")}
					</p>
					{!cliMissing ? (
						<code className="mt-2 block w-fit rounded border border-border/60 bg-background/50 px-2 py-1 font-mono text-[12px] text-foreground">
							{GITHUB_LOGIN_COMMAND}
						</code>
					) : null}
					<div className="mt-2 flex flex-wrap items-center gap-2">
						<button
							type="button"
							className="settings-footer-button settings-footer-button-primary"
							onClick={() =>
								cliMissing
									? void aoBridge.app.openExternal(GITHUB_CLI_INSTALL_URL)
									: void copyLoginCommand()
							}
						>
							{cliMissing ? null : copied ? <Check className="size-icon-sm" aria-hidden="true" /> : <Copy className="size-icon-sm" aria-hidden="true" />}
							{cliMissing
								? t("startup.openGithubCliDocs")
								: copied
									? t("startup.commandCopied")
									: t("startup.copyGithubLogin")}
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
				</div>
			</div>
		</div>
	);
}
