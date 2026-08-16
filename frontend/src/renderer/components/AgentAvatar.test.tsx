import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentAvatar } from "./AgentAvatar";

describe("AgentAvatar", () => {
	it("renders the Prime Agent brand asset", () => {
		render(<AgentAvatar provider="prime-agent" />);

		expect(screen.getByRole("img", { name: "prime-agent" })).toHaveAttribute(
			"src",
			expect.stringContaining("prime-agent.png"),
		);
	});

	it("renders the DeepSeek Harness brand asset", () => {
		render(<AgentAvatar provider="deepseek-harness" />);

		const img = screen.queryByRole("img", { name: "deepseek-harness" });
		if (img?.tagName.toLowerCase() === "img") {
			expect(img).toHaveAttribute("src", expect.stringContaining("data:image/svg+xml"));
		} else {
			const svg = screen.getByLabelText("deepseek-harness");
			expect(svg.tagName.toLowerCase()).toBe("svg");
		}
	});
});
