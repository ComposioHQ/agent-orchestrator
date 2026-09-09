import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { components } from "../../../api/schema";
import { ModelTuningControls } from "./ModelTuningControls";

type Model = components["schemas"]["AgentModelInfo"];

const models: Model[] = [
	{
		id: "capable",
		label: "Capable",
		isDefault: true,
		efforts: ["low", "high"],
		speedModes: [{ id: "standard", label: "Standard" }, { id: "fast", label: "Fast" }],
	},
	{ id: "plain", label: "Plain", efforts: ["low"] },
];

describe("ModelTuningControls", () => {
	it("exposes provider defaults and accessible effort and speed selectors", async () => {
		const onEffortChange = vi.fn();
		const onSpeedModeChange = vi.fn();
		render(
			<ModelTuningControls
				models={models}
				model="capable"
				effort=""
				speedMode=""
				onEffortChange={onEffortChange}
				onSpeedModeChange={onSpeedModeChange}
				variant="settings"
				roleLabel="Worker"
			/>,
		);

		const effort = screen.getByRole("button", { name: "Worker Effort" });
		const speed = screen.getByRole("button", { name: "Worker Speed" });
		expect(effort).toHaveTextContent("Provider default");
		expect(speed).toHaveTextContent("Provider default");
		await userEvent.click(speed);
		await userEvent.click(await screen.findByRole("menuitem", { name: "Fast" }));
		expect(onSpeedModeChange).toHaveBeenCalledWith("fast");
	});

	it("clears incompatible dependent selections when the model changes", () => {
		const onEffortChange = vi.fn();
		const onSpeedModeChange = vi.fn();
		const view = render(
			<ModelTuningControls
				models={models}
				model="capable"
				effort="high"
				speedMode="fast"
				onEffortChange={onEffortChange}
				onSpeedModeChange={onSpeedModeChange}
				variant="composer"
			/>,
		);
		view.rerender(
			<ModelTuningControls
				models={models}
				model="plain"
				effort="high"
				speedMode="fast"
				onEffortChange={onEffortChange}
				onSpeedModeChange={onSpeedModeChange}
				variant="composer"
			/>,
		);

		expect(onEffortChange).toHaveBeenCalledWith("");
		expect(onSpeedModeChange).toHaveBeenCalledWith("");
		expect(screen.queryByRole("button", { name: "Speed" })).not.toBeInTheDocument();
	});

	it("warns and marks unsupported saved values invalid until corrected", () => {
		const onValidityChange = vi.fn();
		render(
			<ModelTuningControls
				models={models}
				model="plain"
				effort="high"
				speedMode="fast"
				onEffortChange={vi.fn()}
				onSpeedModeChange={vi.fn()}
				onValidityChange={onValidityChange}
				variant="settings"
				roleLabel="Reviewer"
			/>,
		);

		expect(screen.getByRole("alert")).toHaveTextContent("Reviewer model tuning is no longer supported");
		expect(onValidityChange).toHaveBeenCalledWith(false);
	});
});
