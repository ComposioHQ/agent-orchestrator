"use client";

import type { ReactNode } from "react";

import { trackPhBadgeClick } from "@/lib/analytics/launch/events";
import { PRODUCT_HUNT_URL } from "@/lib/analytics/launch/utm";

type ProductHuntBadgeProps = {
	/**
	 * The badge visual. Pass Product Hunt's official embed `<img>` here so we do
	 * not hardcode an asset (the embed URL depends on the launch/post id). When
	 * omitted, a plain text label is rendered so the CTA still works.
	 */
	children?: ReactNode;
	className?: string;
};

/**
 * A drop-in Product Hunt badge for launch day. It links to our Product Hunt
 * page and fires `ph_badge_click` on click. Place it in the hero or header
 * during the launch; remove it after. It intentionally does not carry UTM back
 * to Product Hunt (the destination is Product Hunt, not our site).
 */
export function ProductHuntBadge({ children, className }: ProductHuntBadgeProps) {
	return (
		<a
			href={PRODUCT_HUNT_URL}
			target="_blank"
			rel="noopener noreferrer"
			className={className}
			aria-label="Agent Orchestrator on Product Hunt"
			onClick={() => trackPhBadgeClick()}
		>
			{children ?? "Find Agent Orchestrator on Product Hunt"}
		</a>
	);
}
