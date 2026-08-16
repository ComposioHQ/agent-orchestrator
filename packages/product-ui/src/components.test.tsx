import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentAvatar } from "./AgentAvatar";
import type { ExternalLinkProps } from "./external-link";
import { PRCardStatusSummary, PRSummaryMeta, PRSummaryParts } from "./PRSummaryDisplay";
import type { PRCardPresentation, PRSummaryPart } from "./pull-request-models";

function ExternalLink({ ariaLabel, children, stopPropagation, ...props }: ExternalLinkProps) {
	return (
		<a
			{...props}
			aria-label={ariaLabel}
			onClick={stopPropagation ? (event) => event.stopPropagation() : undefined}
		>
			{children}
		</a>
	);
}

describe("portable leaf components", () => {
	it("renders an injected agent logo without owning app assets", () => {
		render(<AgentAvatar logoSources={{ "claude-code": "/logos/claude.svg" }} provider="claude-code" />);

		expect(screen.getByRole("img", { name: "claude-code" })).toHaveAttribute(
			"src",
			"/logos/claude.svg",
		);
	});

	it("renders fallback identity metadata for unknown agents", () => {
		render(<AgentAvatar provider="new-agent" />);

		expect(screen.getByRole("img", { name: "new-agent" })).toHaveTextContent("N");
	});

	it("renders neutral PR metadata with injected plural labels", () => {
		render(
			<PRSummaryMeta
				countNounLabel={(count, noun) => `${count} localized-${noun}`}
				externalLink={ExternalLink}
				pr={{
					provider: "github",
					author: "ada",
					sourceBranch: "feature",
					targetBranch: "main",
					changedFiles: 2,
					additions: 4,
					deletions: 1,
				}}
			/>,
		);

		expect(screen.getByText("feature → main")).toBeInTheDocument();
		expect(screen.getByText("2 localized-file")).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "@ada" })).toHaveAttribute("href", "https://github.com/ada");
	});

	it("renders precomputed PR presentation without controller dependencies", () => {
		const presentation: PRCardPresentation = {
			primary: {
				key: "review",
				label: "Review required",
				tone: "review",
				links: [],
			},
			supporting: [
				{
					key: "ci",
					label: "Checks running",
					href: "https://example.com/checks",
					breathe: true,
					tone: "neutral",
					links: [],
				},
			],
		};
		const { container } = render(
			<PRCardStatusSummary externalLink={ExternalLink} presentation={presentation} />,
		);

		expect(screen.getByText("Review required")).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "Checks running" })).toBeInTheDocument();
		expect(container.querySelector(".animate-status-pulse")).toBeInTheDocument();
	});

	it("computes overflow against the requested link limit", () => {
		const parts: PRSummaryPart[] = [
			{
				key: "ci",
				label: "CI",
				status: "Failing",
				links: [{ label: "unit" }, { label: "lint" }, { label: "types" }],
				linkTotal: 3,
				overflowNoun: "check",
				tone: "error",
			},
		];
		render(
			<PRSummaryParts
				externalLink={ExternalLink}
				interactiveLinks={false}
				maxLinks={2}
				parts={parts}
			/>,
		);

		expect(screen.getByText("unit")).toBeInTheDocument();
		expect(screen.getByText("lint")).toBeInTheDocument();
		expect(screen.queryByText("types")).not.toBeInTheDocument();
		expect(screen.getByText("+1 check")).toBeInTheDocument();
	});
});
