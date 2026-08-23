import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";
import { ConnectMobileContent } from "./settings/ConnectMobileContent";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	settingsDialogBodyClass,
	settingsDialogContentClass,
	settingsDialogHeaderClass,
} from "./ui/dialog";

export { pairingPayload } from "./settings/ConnectMobileContent";

interface ConnectMobileModalProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

// The sidebar entry point uses the same pairing surface as Settings. Keeping
// one content component prevents the standalone modal and inline accordion
// from drifting into separate setup flows again.
export function ConnectMobileModal({ open, onOpenChange }: ConnectMobileModalProps) {
	const { t } = useTranslation();

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				showCloseButton={false}
				className={cn(
					settingsDialogContentClass,
					"w-[min(var(--size-settings-mobile-dialog),calc(100vw-var(--space-8)))]",
				)}
			>
				<DialogClose asChild>
					<button
						type="button"
						className="settings-dialog-close-button settings-close-button"
						aria-label={t("mobile.close")}
					>
						<X className="size-5" aria-hidden="true" />
					</button>
				</DialogClose>
				<DialogHeader className={cn(settingsDialogHeaderClass, "items-start border-b-0 text-left")}>
					<DialogTitle className="settings-dialog-title text-left">{t("mobile.title")}</DialogTitle>
					<DialogDescription className="sr-only">{t("mobile.description")}</DialogDescription>
				</DialogHeader>
				<div className={cn(settingsDialogBodyClass, "max-h-[80vh] gap-0 scrollbar-none")}>
					<ConnectMobileContent active={open} />
				</div>
			</DialogContent>
		</Dialog>
	);
}
