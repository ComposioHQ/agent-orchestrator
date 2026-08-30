import { useTranslation } from "react-i18next";
import type { HostSection } from "../types/workspace";
import { LOCAL_HOST, type HostId } from "../lib/hosts";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "./ui/select";

const ALL_HOSTS = "__all-hosts__";

type HostSwitcherProps = {
	hosts: HostSection[];
	value: HostId | null;
	onChange: (host: HostId | null) => void;
};

// A view filter only. Choosing a row never reconnects a host or changes where
// project/session actions are sent; those remain routed by each item's Ref.
export function HostSwitcher({ hosts, value, onChange }: HostSwitcherProps) {
	const { t } = useTranslation();
	const selected = hosts.find((host) => host.host === value);
	const selectedLabel = selected?.host === LOCAL_HOST ? t("hosts.local") : selected?.label;

	return (
		<>
			{/* The filter's effect is the tree redrawing behind it, which a screen
			    reader has no reason to revisit. Say where the tree now points. */}
			<p role="status" className="sr-only">
				{value === null ? t("hosts.allHosts") : t("hosts.viewing", { host: selectedLabel ?? value })}
			</p>
			<Select
				value={value ?? ALL_HOSTS}
				onValueChange={(next) => onChange(next === ALL_HOSTS ? null : next)}
			>
				<SelectTrigger size="sm" className="w-full" aria-label={t("hosts.label")}>
					<SelectValue>
						<span className="min-w-0 truncate">{selectedLabel ?? t("hosts.allHosts")}</span>
					</SelectValue>
				</SelectTrigger>
				<SelectContent position="popper" className="min-w-(--radix-select-trigger-width)">
					<SelectItem value={ALL_HOSTS}>{t("hosts.allHosts")}</SelectItem>
					<SelectSeparator />
					{hosts.map((host) => (
						<SelectItem key={host.host} value={host.host}>
							{host.host === LOCAL_HOST ? t("hosts.local") : host.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</>
	);
}
