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

	it("renders the DeepSeek brand asset", () => {
		render(<AgentAvatar provider="deepseek-harness" />);

		const image = screen.getByRole("img", { name: "deepseek-harness" });
		expect(image).toHaveAttribute("src", expect.stringMatching(/^data:image\/svg\+xml/));
		expect(image.getAttribute("src")).toContain("DeepSeek");
	});

	it("renders the OMP brand asset", () => {
		render(<AgentAvatar provider="omp" />);

		expect(screen.getByRole("img", { name: "omp" })).toHaveAttribute("src", expect.stringContaining("omp.png"));
	});
});
