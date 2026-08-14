import { StartupLoaderView } from "@aoagents/product-ui";
import { useTranslation } from "react-i18next";
import aoLogo from "../../../assets/ao-logo.svg";

const STARTUP_PHRASE_KEYS = [
	"startup.startingServices",
	"startup.connectingDaemon",
	"startup.loadingWorkspaces",
	"startup.preparingBoard",
] as const;

export function DaemonStartupLoader() {
	const { t } = useTranslation();
	const phrases = STARTUP_PHRASE_KEYS.map((key) => t(key));

	return (
		<StartupLoaderView
			ariaLabel={t("startup.aria", { brand: "Agent Orchestrator" })}
			brand="Agent Orchestrator"
			logo={<img className="ao-startup-logo h-22 w-25 object-contain" src={aoLogo} alt="" />}
			phrases={phrases}
			testId="daemon-startup-loader"
		/>
	);
}
