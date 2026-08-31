import { useEffect, useRef } from "react";
import QRCodeStyling from "qr-code-styling";
import { useUiStore } from "../../stores/ui-store";
import aoLogo from "../../assets/ao-logo.svg";

/**
 * Themed, rounded-dot QR (qr-code-styling) with the AO logo in the middle.
 * Colors resolve from the live CSS variables at render time, so the code
 * re-tints when the color theme changes. No scanning-frame decoration.
 */
export function StyledQRCode({
	value,
	size,
	showLogo = true,
	className,
	"data-qr-value": dataQrValue,
}: {
	value: string;
	size: number;
	showLogo?: boolean;
	className?: string;
	"data-qr-value"?: string;
}) {
	const ref = useRef<HTMLDivElement>(null);
	// Re-generate when the theme changes — qr-code-styling bakes concrete
	// colors into the SVG, so CSS variables can't do the retint on their own.
	const themeStyle = useUiStore((state) => state.themeStyle);
	const themePreference = useUiStore((state) => state.themePreference);

	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const color =
			getComputedStyle(el).getPropertyValue("--color-text-settings-title").trim() || "#f4f5f7";
		try {
			const qr = new QRCodeStyling({
				width: size,
				height: size,
				type: "svg",
				data: value,
				image: showLogo ? aoLogo : undefined,
				margin: 0,
				// Lower error correction = fewer modules = chunkier dots, so a
				// generated (long-payload) code reads at the same visual weight as
				// the short placeholder behind the blur.
				qrOptions: { errorCorrectionLevel: "M" },
				backgroundOptions: { color: "transparent" },
				dotsOptions: { color, type: "rounded" },
				cornersSquareOptions: { color, type: "extra-rounded" },
				cornersDotOptions: { color, type: "dot" },
				imageOptions: { imageSize: 0.45, margin: 8, hideBackgroundDots: true, crossOrigin: "anonymous" },
			});
			el.replaceChildren();
			qr.append(el);
		} catch {
			// jsdom / non-browser environments can't render the SVG; the QR is
			// purely visual, so fail silent rather than crash the settings page.
		}
	}, [value, size, showLogo, themeStyle, themePreference]);

	return <div ref={ref} className={className} data-qr-value={dataQrValue} />;
}
