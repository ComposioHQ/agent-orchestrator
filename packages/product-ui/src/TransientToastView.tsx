import { type ReactNode } from "react";
import { cn } from "./utils";

export function TransientToastView({
	children,
	className,
	tone = "error",
}: {
	children: ReactNode;
	className?: string;
	tone?: "error" | "neutral";
}) {
	return (
		<div
			className={cn(
				"pointer-events-none fixed right-5 bottom-5 z-[200] max-w-sm rounded-md border bg-popover px-3.5 py-2.5 text-xs text-popover-foreground shadow-xl",
				tone === "error" && "border-destructive/35 text-destructive",
				className,
			)}
			role={tone === "error" ? "alert" : "status"}
		>
			{children}
		</div>
	);
}
