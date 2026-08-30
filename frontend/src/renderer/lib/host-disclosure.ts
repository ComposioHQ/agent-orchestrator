import type { TFunction } from "i18next";
import { hostLabelFor } from "./host-clients";
import { LOCAL_HOST, type HostId } from "./hosts";

/** Name the target machine anywhere a destructive action is described. */
export function hostActionSuffix(t: TFunction, host: HostId): string {
	return host === LOCAL_HOST ? "" : ` ${t("hosts.on", { host: hostLabelFor(host) })}`;
}
