import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ChatConfigOption } from "../../types/conversation";
import { TurnSettingsBar } from "./TurnSettingsBar";

const OPTIONS: ChatConfigOption[] = [
	{
		id: "model",
		name: "Model",
		category: "model",
		type: "select",
		currentValue: "opus",
		choices: [
			{ value: "opus", name: "Opus 5" },
			{ value: "sonnet", name: "Sonnet 5" },
		],
	},
	{
		id: "effort",
		name: "Effort",
		category: "thought_level",
		type: "select",
		currentValue: "high",
		choices: [{ value: "high", name: "High" }],
	},
	{
		id: "mode",
		name: "Permission mode",
		category: "mode",
		type: "select",
		currentValue: "ask",
		choices: [{ value: "ask", name: "Ask before edits" }],
	},
	{
		id: "fast",
		name: "Fast mode",
		type: "boolean",
		currentBoolean: false,
		choices: [],
	},
	{
		id: "agent",
		name: "Agent",
		type: "select",
		currentValue: "reviewer",
		choices: [{ value: "reviewer", name: "Code reviewer" }],
	},
];

describe("ACP session config options", () => {
	it("renders every advertised control without inventing a Claude-specific list", () => {
		render(
			<TurnSettingsBar
				models={[]}
				settings={{}}
				configOptions={OPTIONS}
				onChangeConfigOption={vi.fn()}
			/>,
		);

		for (const label of ["Opus 5", "High", "Ask before edits", "Off", "Code reviewer"]) {
			expect(screen.getByText(label)).toBeInTheDocument();
		}
		for (const name of ["Model", "Effort", "Permission mode", "Fast mode", "Agent"]) {
			expect(screen.getByRole("button", { name }).querySelectorAll("svg")).toHaveLength(1);
		}
		// The generic permission option owns this choice; AO's separate approval
		// picker must not be duplicated beside it.
		expect(screen.queryByText("Provider default")).not.toBeInTheDocument();
	});

	it("sends the provider's opaque value id when a selection changes", async () => {
		const onChange = vi.fn();
		const user = userEvent.setup();
		render(
			<TurnSettingsBar
				models={[]}
				settings={{}}
				configOptions={[OPTIONS[0]]}
				onChangeConfigOption={onChange}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "Model" }));
		await user.click(screen.getByRole("menuitem", { name: "Sonnet 5" }));
		expect(onChange).toHaveBeenCalledWith("model", { value: "sonnet" });
	});

	it("never renders an unadvertised model as selectable", async () => {
		const user = userEvent.setup();
		render(
			<TurnSettingsBar
				models={[]}
				settings={{}}
				configOptions={[
					{
						...OPTIONS[0],
						currentValue: "provider/sonnet",
						choices: [{ value: "provider/sonnet", name: "Sonnet" }],
					},
				]}
				onChangeConfigOption={vi.fn()}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "Model" }));
		expect(screen.getByRole("menuitem", { name: /Sonnet/ })).toBeInTheDocument();
		expect(screen.queryByRole("menuitem", { name: /Opus/i })).not.toBeInTheDocument();
	});

	it("updates its label to the provider current value when the catalog changes", () => {
		const { rerender } = render(
			<TurnSettingsBar
				models={[]}
				settings={{}}
				configOptions={[OPTIONS[0]]}
				onChangeConfigOption={vi.fn()}
			/>,
		);
		expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("Opus 5");

		rerender(
			<TurnSettingsBar
				models={[]}
				settings={{}}
				configOptions={[
					{
						...OPTIONS[0],
						currentValue: "sonnet",
						choices: [{ value: "sonnet", name: "Sonnet 5" }],
					},
				]}
				onChangeConfigOption={vi.fn()}
			/>,
		);
		expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("Sonnet 5");
		expect(screen.queryByText("Opus 5")).not.toBeInTheDocument();
	});
});
