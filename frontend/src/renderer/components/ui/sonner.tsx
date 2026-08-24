import type { CSSProperties } from "react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

// Colors piggyback on the app's own tokens (DESIGN.md) so toasts stay in sync
// with theme/style switches without their own light/dark branching.
export function Toaster(props: ToasterProps) {
	return (
		<Sonner
			className="toaster group"
			style={
				{
					"--normal-bg": "var(--popover)",
					"--normal-text": "var(--popover-foreground)",
					"--normal-border": "var(--border)",
					"--error-bg": "var(--popover)",
					"--error-text": "var(--red)",
					"--error-border": "color-mix(in srgb, var(--red) 30%, var(--border))",
				} as CSSProperties
			}
			{...props}
		/>
	);
}
