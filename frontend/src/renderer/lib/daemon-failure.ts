import type { DaemonStatus } from "../../shared/daemon-status";
import type { TFunction } from "i18next";
import { appI18n } from "../i18n";

export function daemonFailureMessage(status: DaemonStatus, t: TFunction = appI18n.t): string {
	// Prefer the daemon-provided English diagnostic when present.
	if (status.message) return status.message;
	if (status.state === "starting") return t("daemon.message.starting");
	return t("daemon.message.notReady");
}

export function daemonFailureTitle(status: DaemonStatus, t: TFunction = appI18n.t): string {
	switch (status.code) {
		case "not_ready":
		case "port_unconfirmed":
			return t("daemon.title.notReady");
		case "not_configured":
			return t("daemon.title.notConfigured");
		case "daemon_unreachable":
			return t("daemon.title.unreachable");
		case "identity_mismatch":
			return t("daemon.title.identityMismatch");
		case "binary_missing":
			return t("daemon.title.binaryMissing");
		case "remote_unauthorized":
		case "remote_unreachable":
		case "remote_tls":
		case "remote_incompatible_api":
		case "remote_disconnected":
			return t("daemon.title.remote");
		case "spawn_failed":
		case "exited":
		default:
			return t("daemon.title.failed");
	}
}

export function daemonFailureHint(status: DaemonStatus, t: TFunction = appI18n.t): string {
	switch (status.code) {
		case "binary_missing":
			return t("daemon.hint.binaryMissing");
		case "spawn_failed":
		case "exited":
			return "";
		case "not_ready":
			return t("daemon.hint.notReady");
		case "not_configured":
			return t("daemon.hint.notConfigured");
		case "daemon_unreachable":
		case "identity_mismatch":
			return t("daemon.hint.conflict");
		case "remote_unauthorized":
			return t("daemon.hint.remoteUnauthorized");
		case "remote_unreachable":
			return t("daemon.hint.remoteUnreachable");
		case "remote_tls":
			return t("daemon.hint.remoteTls");
		case "remote_incompatible_api":
			return t("daemon.hint.remoteIncompatibleApi");
		case "remote_disconnected":
			return t("daemon.hint.remoteDisconnected");
		default:
			return t("daemon.hint.default");
	}
}
