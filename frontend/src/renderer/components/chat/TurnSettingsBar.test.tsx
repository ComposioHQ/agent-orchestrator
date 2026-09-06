import { render, screen, within } from "@testing-library/react";
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
		currentValue: "bypass",
		choices: [
			{ value: "plan", name: "Plan Mode" },
			{ value: "manual", name: "Manual" },
			{ value: "bypass", name: "Bypass Permissions" },
		],
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
	it("keeps model, effort, and provider mode explicit while hiding ACP agent internals", async () => {
		const user = userEvent.setup();
		render(
			<TurnSettingsBar
				models={[]}
				settings={{}}
				configOptions={OPTIONS}
				onChangeConfigOption={vi.fn()}
			/>,
		);

		const tools = screen.getByRole("group", { name: "Turn settings" });
		expect(
			within(tools).getByRole("button", { name: "Model and reasoning effort for the next turn" }),
		).toHaveTextContent("Opus 5 High");
		expect(within(tools).getByRole("button", { name: "Permission mode" })).toHaveTextContent(
			"Bypass Permissions",
		);
		expect(within(tools).queryByRole("button", { name: "Fast mode" })).not.toBeInTheDocument();
		expect(within(tools).queryByRole("button", { name: "Agent" })).not.toBeInTheDocument();
		expect(screen.queryByText("Default")).not.toBeInTheDocument();
		expect(screen.queryByText("Provider default")).not.toBeInTheDocument();

		await user.click(
			screen.getByRole("button", { name: "Model and reasoning effort for the next turn" }),
		);
		expect(screen.getByText("Model")).toBeInTheDocument();
		expect(screen.getByText("Effort")).toBeInTheDocument();
		expect(screen.getByRole("switch", { name: "Plan Mode" })).toBeInTheDocument();
		expect(screen.getByRole("switch", { name: "Fast mode" })).toBeInTheDocument();
		expect(screen.queryByText("Agent")).not.toBeInTheDocument();
		expect(screen.queryByText("More")).not.toBeInTheDocument();
	});

	it("maps Agent Mode back to the provider's Manual value", async () => {
		const onChange = vi.fn();
		const user = userEvent.setup();
		render(
			<TurnSettingsBar
				models={[]}
				settings={{}}
				configOptions={[OPTIONS[0], { ...OPTIONS[2], currentValue: "plan" }]}
				onChangeConfigOption={onChange}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "Model and reasoning effort for the next turn" }));
		await user.click(screen.getByRole("switch", { name: "Plan Mode" }));
		expect(onChange).toHaveBeenCalledWith("mode", { value: "manual" });
	});

	it("keeps a select-based Fast Mode beside Plan Mode instead of nesting it under More", async () => {
		const onChange = vi.fn();
		const user = userEvent.setup();
		render(
			<TurnSettingsBar
				models={[]}
				settings={{}}
				configOptions={[
					OPTIONS[0],
					OPTIONS[2],
					{
						id: "fast-mode",
						name: "Fast mode",
						type: "select",
						currentValue: "off",
						choices: [
							{ value: "on", name: "On" },
							{ value: "off", name: "Off" },
						],
					},
				]}
				onChangeConfigOption={onChange}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "Model and reasoning effort for the next turn" }));
		expect(screen.getByRole("switch", { name: "Plan Mode" })).toBeInTheDocument();
		expect(screen.getByRole("switch", { name: "Fast mode" })).toBeInTheDocument();
		expect(screen.queryByText("More")).not.toBeInTheDocument();
		await user.click(screen.getByRole("switch", { name: "Fast mode" }));
		expect(onChange).toHaveBeenCalledWith("fast-mode", { value: "on" });
	});

	it("keeps renamed boolean provider options beside the execution mode", async () => {
		const user = userEvent.setup();
		render(
			<TurnSettingsBar
				models={[]}
				settings={{}}
				configOptions={[
					OPTIONS[0],
					OPTIONS[2],
					{ id: "turbo", name: "Turbo", type: "boolean", currentBoolean: false, choices: [] },
				]}
				onChangeConfigOption={vi.fn()}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "Model and reasoning effort for the next turn" }));
		expect(screen.getByRole("switch", { name: "Turbo" })).toBeInTheDocument();
		expect(screen.queryByText("More")).not.toBeInTheDocument();
	});

	it("keeps unclassified provider options accessible", async () => {
		const user = userEvent.setup();
		render(
			<TurnSettingsBar
				models={[]}
				settings={{}}
				configOptions={[
					OPTIONS[0],
					{
						id: "verbosity",
						name: "Verbosity",
						type: "select",
						currentValue: "high",
						choices: [
							{ value: "low", name: "Low" },
							{ value: "high", name: "High" },
						],
					},
				]}
				onChangeConfigOption={vi.fn()}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "Model and reasoning effort for the next turn" }));
		expect(screen.getByText("More")).toBeInTheDocument();
	});

	it("disables provider controls while a catalog-replacing change is in flight", () => {
		render(
			<TurnSettingsBar
				models={[]}
				settings={{}}
				configOptions={[OPTIONS[0]]}
				configPending
				onChangeConfigOption={vi.fn()}
			/>,
		);

		expect(screen.getByRole("button", { name: "Model" })).toBeDisabled();
	});

	it("hides permissions while the provider is in plan mode", () => {
		render(
			<TurnSettingsBar
				models={[]}
				settings={{}}
				configOptions={[OPTIONS[0], { ...OPTIONS[2], currentValue: "plan" }]}
				onChangeConfigOption={vi.fn()}
			/>,
		);

		expect(screen.getByRole("button", { name: "Model and reasoning effort for the next turn" })).toHaveTextContent("Opus 5");
		expect(screen.queryByRole("button", { name: "Permission mode" })).not.toBeInTheDocument();
	});

	it("keeps plan and agent modes out of the permissions menu", async () => {
		const user = userEvent.setup();
		render(
			<TurnSettingsBar
				models={[]}
				settings={{}}
				configOptions={[OPTIONS[2]]}
				onChangeConfigOption={vi.fn()}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "Permission mode" }));
		expect(screen.getByRole("menuitem", { name: "Manual" })).toBeInTheDocument();
		expect(screen.getByRole("menuitem", { name: "Bypass Permissions" })).toBeInTheDocument();
		expect(screen.queryByRole("menuitem", { name: "Plan Mode" })).not.toBeInTheDocument();
		expect(screen.queryByRole("menuitem", { name: "Agent Mode" })).not.toBeInTheDocument();
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

	it("shows Codex's three native permission choices", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(
			<TurnSettingsBar
				harness="codex"
				models={[]}
				settings={{}}
				onChange={onChange}
			/>,
		);

		expect(screen.getByRole("button", { name: "Approval policy for the next turn" })).toHaveTextContent(
			"Full access",
		);
		await user.click(screen.getByRole("button", { name: "Approval policy for the next turn" }));
		expect(screen.getByRole("menuitem", { name: "Ask for approval" })).toBeInTheDocument();
		expect(screen.getByRole("menuitem", { name: "Approve for me" })).toBeInTheDocument();
		expect(screen.getByRole("menuitem", { name: "Bypass permissions" })).toBeInTheDocument();
		expect(screen.queryByRole("menuitem", { name: "Default approvals" })).not.toBeInTheDocument();
		expect(screen.queryByRole("menuitem", { name: "Accept edits" })).not.toBeInTheDocument();
		expect(screen.queryByRole("menuitem", { name: "Auto-approve" })).not.toBeInTheDocument();
		expect(screen.getByRole("menuitem", { name: "Full access" })).toBeInTheDocument();

		await user.click(screen.getByRole("menuitem", { name: "Approve for me" }));
		expect(onChange).toHaveBeenCalledWith({ approvalMode: "auto" });
	});

	it("keeps Codex native model+effort in one trigger when the provider has no catalog", () => {
		render(
			<TurnSettingsBar
				harness="codex"
				models={[
					{ id: "gpt-5.6-terra", displayName: "gpt-5.6-terra", default: true, efforts: ["high"] },
				]}
				settings={{ model: "gpt-5.6-terra", reasoningEffort: "high" }}
				onChange={vi.fn()}
			/>,
		);

		expect(
			screen.getByRole("button", { name: "Model and reasoning effort for the next turn" }),
		).toHaveTextContent("gpt-5.6-terra High");
		expect(screen.getByRole("button", { name: "Approval policy for the next turn" })).toHaveTextContent(
			"Full access",
		);
	});

	it("labels bypass permission policy plainly", () => {
		render(
			<TurnSettingsBar
				models={[]}
				settings={{ approvalMode: "bypass-permissions" }}
				onChange={vi.fn()}
			/>,
		);

		expect(screen.getByRole("button", { name: "Approval policy for the next turn" })).toHaveTextContent(
			"Bypass permissions",
		);
	});
	it("distinguishes Codex bypass permissions from its default full-access posture", () => {
		render(
			<TurnSettingsBar
				harness="codex"
				models={[]}
				settings={{ approvalMode: "bypass-permissions" }}
				onChange={vi.fn()}
			/>,
		);

		expect(screen.getByRole("button", { name: "Approval policy for the next turn" })).toHaveTextContent(
			"Bypass permissions",
		);
	});
	it("keeps a lone extra option as its own picker rather than inventing a model menu", () => {
		render(
			<TurnSettingsBar
				models={[]}
				settings={{}}
				configOptions={[OPTIONS[3]]}
				onChangeConfigOption={vi.fn()}
			/>,
		);

		expect(screen.getByRole("button", { name: "Fast mode" })).toHaveTextContent("Off");
		expect(
			screen.queryByRole("button", { name: "Model and reasoning effort for the next turn" }),
		).not.toBeInTheDocument();
	});
});

describe("native model selection", () => {
	it("keeps an explicit model visible when the catalog does not contain it", () => {
		render(
			<TurnSettingsBar
				models={[
					{ id: "astra", displayName: "Astra", default: true, efforts: ["high"], defaultEffort: "high" },
				]}
				settings={{ model: "nano" }}
				onChange={vi.fn()}
				harness="codex"
			/>,
		);
		expect(
			screen.getByRole("button", { name: "Model and reasoning effort for the next turn" }),
		).toHaveTextContent(/^nano$/);
	});
});

describe("Cursor Ask and Agent chat modes", () => {
	// Values are deliberately not lowercase: AO must round-trip whatever the
	// provider advertised, never a value re-derived from the label.
	const CURSOR_MODE: ChatConfigOption = {
		id: "mode",
		name: "Chat mode",
		category: "mode",
		type: "select",
		currentValue: "ASK",
		choices: [
			{ value: "ASK", name: "Ask" },
			{ value: "AGENT", name: "Agent" },
		],
	};

	it("treats Ask and Agent as execution modes when one option advertises the pair", async () => {
		const user = userEvent.setup();
		render(
			<TurnSettingsBar
				harness="cursor"
				models={[]}
				settings={{}}
				configOptions={[CURSOR_MODE]}
				onChangeConfigOption={vi.fn()}
			/>,
		);

		const trigger = screen.getByRole("button", { name: "Model mode for the next turn" });
		await user.click(trigger);
		expect(screen.getByRole("menuitem", { name: "Ask" })).toBeInTheDocument();
		expect(screen.getByRole("menuitem", { name: "Agent" })).toBeInTheDocument();
		expect(screen.queryByRole("switch", { name: "Plan Mode" })).not.toBeInTheDocument();
	});

	it("shows the provider's current choice, starting on Ask", () => {
		render(
			<TurnSettingsBar
				harness="cursor"
				models={[]}
				settings={{}}
				configOptions={[CURSOR_MODE]}
				onChangeConfigOption={vi.fn()}
			/>,
		);

		expect(screen.getByRole("button", { name: "Model mode for the next turn" })).toHaveTextContent(
			"Ask",
		);
	});

	it("shows Agent on the trigger once the provider reports Agent", () => {
		render(
			<TurnSettingsBar
				harness="cursor"
				models={[]}
				settings={{}}
				configOptions={[{ ...CURSOR_MODE, currentValue: "AGENT" }]}
				onChangeConfigOption={vi.fn()}
			/>,
		);

		expect(screen.getByRole("button", { name: "Model mode for the next turn" })).toHaveTextContent(
			"Agent",
		);
	});

	it("sends each mode's exact advertised value rather than a normalized label", async () => {
		const onChange = vi.fn();
		const user = userEvent.setup();
		render(
			<TurnSettingsBar
				harness="cursor"
				models={[]}
				settings={{}}
				configOptions={[CURSOR_MODE]}
				onChangeConfigOption={onChange}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "Model mode for the next turn" }));
		await user.click(screen.getByRole("menuitem", { name: "Agent" }));
		expect(onChange).toHaveBeenCalledWith("mode", { value: "AGENT" });

		await user.click(screen.getByRole("button", { name: "Model mode for the next turn" }));
		await user.click(screen.getByRole("menuitem", { name: "Ask" }));
		expect(onChange).toHaveBeenLastCalledWith("mode", { value: "ASK" });
	});

	it("exposes exactly one execution control for the Ask/Agent pair", () => {
		render(
			<TurnSettingsBar
				harness="cursor"
				models={[]}
				settings={{}}
				configOptions={[CURSOR_MODE]}
				onChangeConfigOption={vi.fn()}
			/>,
		);

		expect(screen.getAllByRole("button", { name: "Model mode for the next turn" })).toHaveLength(1);
		expect(screen.queryByRole("button", { name: "Chat mode" })).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Approval policy for the next turn" }),
		).not.toBeInTheDocument();
	});

	it("keeps Ask out of the approval menu, which stays AO's own policy list", async () => {
		const user = userEvent.setup();
		render(
			<TurnSettingsBar
				harness="cursor"
				models={[]}
				settings={{}}
				configOptions={[CURSOR_MODE]}
				onChange={vi.fn()}
				onChangeConfigOption={vi.fn()}
			/>,
		);

		const approvals = screen.getByRole("button", { name: "Approval policy for the next turn" });
		await user.click(approvals);
		expect(screen.queryByRole("menuitem", { name: "Ask" })).not.toBeInTheDocument();
		expect(screen.queryByRole("menuitem", { name: "Agent" })).not.toBeInTheDocument();
		expect(screen.getByRole("menuitem", { name: "Default approvals" })).toBeInTheDocument();
		expect(screen.getByRole("menuitem", { name: "Accept edits" })).toBeInTheDocument();
		expect(screen.getByRole("menuitem", { name: "Auto-approve" })).toBeInTheDocument();
		expect(screen.getByRole("menuitem", { name: "Bypass permissions" })).toBeInTheDocument();
	});

	it("does not read a lone approval-flavoured Ask as an execution mode", async () => {
		const user = userEvent.setup();
		render(
			<TurnSettingsBar
				models={[]}
				settings={{}}
				configOptions={[
					{
						id: "mode",
						name: "Permission mode",
						category: "mode",
						type: "select",
						currentValue: "ask",
						choices: [
							{ value: "ask", name: "Ask for approval" },
							{ value: "auto", name: "Approve for me" },
						],
					},
				]}
				onChangeConfigOption={vi.fn()}
			/>,
		);

		expect(
			screen.queryByRole("button", { name: "Model mode for the next turn" }),
		).not.toBeInTheDocument();
		const trigger = screen.getByRole("button", { name: "Permission mode" });
		expect(trigger).toHaveTextContent("Ask for approval");
		await user.click(trigger);
		expect(screen.getByRole("menuitem", { name: "Ask for approval" })).toBeInTheDocument();
		expect(screen.getByRole("menuitem", { name: "Approve for me" })).toBeInTheDocument();
	});

	it("keeps the Plan/Agent switch and its Manual wire value unchanged", async () => {
		const onChange = vi.fn();
		const user = userEvent.setup();
		render(
			<TurnSettingsBar
				models={[]}
				settings={{}}
				configOptions={[OPTIONS[2]]}
				onChangeConfigOption={onChange}
			/>,
		);

		expect(screen.getByRole("button", { name: "Permission mode" })).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Model mode for the next turn" }));
		const planSwitch = screen.getByRole("switch", { name: "Plan Mode" });
		expect(planSwitch).not.toBeChecked();
		await user.click(planSwitch);
		expect(onChange).toHaveBeenCalledWith("mode", { value: "plan" });
	});

	it("does not confuse a provider-owned agent option with AO's Switch agent", async () => {
		const user = userEvent.setup();
		render(
			<TurnSettingsBar
				harness="cursor"
				models={[]}
				settings={{}}
				configOptions={[CURSOR_MODE, OPTIONS[4]]}
				onChangeConfigOption={vi.fn()}
			/>,
		);

		// The ACP `agent` option stays out of the composer entirely; only the
		// Ask/Agent execution posture is offered here.
		expect(screen.queryByRole("button", { name: "Agent" })).not.toBeInTheDocument();
		expect(screen.queryByText("Code reviewer")).not.toBeInTheDocument();
		const trigger = screen.getByRole("button", { name: "Model mode for the next turn" });
		expect(trigger).toHaveTextContent("Ask");
		await user.click(trigger);
		expect(screen.queryByRole("menuitem", { name: "Code reviewer" })).not.toBeInTheDocument();
	});
});

// Captured from a live `cursor-agent acp` session/new response: Cursor advertises
// three postures in one mode option, alongside its own model catalog.
describe("Cursor's live Agent/Plan/Ask mode catalog", () => {
	const CURSOR_MODES: ChatConfigOption = {
		id: "mode",
		name: "Mode",
		category: "mode",
		type: "select",
		currentValue: "agent",
		choices: [
			{ value: "agent", name: "Agent", description: "Full agent capabilities with tool access" },
			{ value: "plan", name: "Plan", description: "Read-only mode for planning" },
			{ value: "ask", name: "Ask", description: "Q&A mode - no edits or command execution" },
		],
	};
	const CURSOR_MODELS: ChatConfigOption = {
		id: "model",
		name: "Model",
		category: "model",
		type: "select",
		currentValue: "grok-4.6[effort=high,fast=true]",
		choices: [
			{ value: "default[]", name: "Auto" },
			{ value: "grok-4.6[effort=high,fast=true]", name: "grok-4.6" },
		],
	};

	it("keeps the mode control visible beside the model picker rather than nested in it", async () => {
		const user = userEvent.setup();
		render(
			<TurnSettingsBar
				harness="cursor"
				models={[]}
				settings={{}}
				configOptions={[CURSOR_MODELS, CURSOR_MODES]}
				onChangeConfigOption={vi.fn()}
			/>,
		);

		const modeTrigger = screen.getByRole("button", { name: "Model mode for the next turn" });
		expect(modeTrigger).toHaveTextContent("Agent");
		expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("grok-4.6");

		await user.click(modeTrigger);
		expect(screen.getByRole("menuitem", { name: "Agent" })).toBeInTheDocument();
		expect(screen.getByRole("menuitem", { name: "Plan" })).toBeInTheDocument();
		expect(screen.getByRole("menuitem", { name: "Ask" })).toBeInTheDocument();
	});

	it("sends Cursor's own mode ids, including the bracketed model ids untouched", async () => {
		const onChange = vi.fn();
		const user = userEvent.setup();
		render(
			<TurnSettingsBar
				harness="cursor"
				models={[]}
				settings={{}}
				configOptions={[CURSOR_MODELS, CURSOR_MODES]}
				onChangeConfigOption={onChange}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "Model mode for the next turn" }));
		await user.click(screen.getByRole("menuitem", { name: "Ask" }));
		expect(onChange).toHaveBeenCalledWith("mode", { value: "ask" });

		await user.click(screen.getByRole("button", { name: "Model mode for the next turn" }));
		await user.click(screen.getByRole("menuitem", { name: "Agent" }));
		expect(onChange).toHaveBeenLastCalledWith("mode", { value: "agent" });

		// The same guarantee on the model side, where Cursor's ids carry brackets
		// that no label normalization may touch.
		await user.click(screen.getByRole("button", { name: "Model" }));
		await user.click(screen.getByRole("menuitem", { name: "grok-4.6" }));
		expect(onChange).toHaveBeenLastCalledWith("model", {
			value: "grok-4.6[effort=high,fast=true]",
		});
	});

	it("shows Ask on the trigger when Cursor reports Ask as current", () => {
		render(
			<TurnSettingsBar
				harness="cursor"
				models={[]}
				settings={{}}
				configOptions={[CURSOR_MODELS, { ...CURSOR_MODES, currentValue: "ask" }]}
				onChangeConfigOption={vi.fn()}
			/>,
		);

		expect(screen.getByRole("button", { name: "Model mode for the next turn" })).toHaveTextContent(
			"Ask",
		);
	});

	it("names the option rather than asserting a posture the provider did not report", () => {
		render(
			<TurnSettingsBar
				harness="cursor"
				models={[]}
				settings={{}}
				configOptions={[{ ...CURSOR_MODES, currentValue: undefined }]}
				onChangeConfigOption={vi.fn()}
			/>,
		);

		const trigger = screen.getByRole("button", { name: "Model mode for the next turn" });
		expect(trigger).toHaveTextContent("Mode");
		expect(trigger).not.toHaveTextContent("Agent Mode");
	});

	it("does not claim a posture when the current value is a permission shown elsewhere", () => {
		render(
			<TurnSettingsBar
				models={[]}
				settings={{}}
				configOptions={[
					{
						id: "mode",
						name: "Chat mode",
						category: "mode",
						type: "select",
						// The posture in force is a permission choice, which the right-hand
						// picker owns; the execution trigger must not speak for it.
						currentValue: "bypass",
						choices: [
							{ value: "agent", name: "Agent" },
							{ value: "ask", name: "Ask" },
							{ value: "plan", name: "Plan" },
							{ value: "bypass", name: "Bypass Permissions" },
						],
					},
				]}
				onChangeConfigOption={vi.fn()}
			/>,
		);

		const trigger = screen.getByRole("button", { name: "Model mode for the next turn" });
		expect(trigger).toHaveTextContent("Chat mode");
		expect(trigger).not.toHaveTextContent("Agent Mode");
		expect(screen.getByRole("button", { name: "Chat mode" })).toHaveTextContent(
			"Bypass Permissions",
		);
	});

	it("keeps an unclassified option reachable when a mode picker is the only other control", async () => {
		const user = userEvent.setup();
		render(
			<TurnSettingsBar
				harness="cursor"
				models={[]}
				settings={{}}
				configOptions={[
					CURSOR_MODES,
					{
						id: "verbosity",
						name: "Verbosity",
						type: "select",
						currentValue: "high",
						choices: [
							{ value: "low", name: "Low" },
							{ value: "high", name: "High" },
						],
					},
				]}
				onChangeConfigOption={vi.fn()}
			/>,
		);

		// The mode moved out to its own trigger; the extra must still have a home.
		expect(screen.getByRole("button", { name: "Model mode for the next turn" })).toHaveTextContent(
			"Agent",
		);
		const extra = screen.getByRole("button", { name: "Verbosity" });
		expect(extra).toHaveTextContent("High");
		await user.click(extra);
		expect(screen.getByRole("menuitem", { name: "Low" })).toBeInTheDocument();
	});

	it("disables the standalone mode trigger and a lone extra while a change is in flight", () => {
		render(
			<TurnSettingsBar
				harness="cursor"
				models={[]}
				settings={{}}
				configOptions={[
					CURSOR_MODES,
					{
						id: "verbosity",
						name: "Verbosity",
						type: "select",
						currentValue: "high",
						choices: [{ value: "low", name: "Low" }],
					},
				]}
				configPending
				onChangeConfigOption={vi.fn()}
			/>,
		);

		expect(screen.getByRole("button", { name: "Model mode for the next turn" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Verbosity" })).toBeDisabled();
	});

	it("offers exactly one execution control and no provider approval picker", () => {
		render(
			<TurnSettingsBar
				harness="cursor"
				models={[]}
				settings={{}}
				configOptions={[CURSOR_MODELS, CURSOR_MODES]}
				onChangeConfigOption={vi.fn()}
			/>,
		);

		expect(screen.getAllByRole("button", { name: "Model mode for the next turn" })).toHaveLength(1);
		// Cursor's approval policy is a Project Settings concern, not a composer one.
		expect(screen.queryByRole("button", { name: "Mode" })).not.toBeInTheDocument();
		expect(screen.queryByRole("switch", { name: "Plan Mode" })).not.toBeInTheDocument();
	});
});
