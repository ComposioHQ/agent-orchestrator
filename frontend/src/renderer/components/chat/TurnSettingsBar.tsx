/**
 * What the next turn will be sent with: model, reasoning effort, approval mode.
 *
 * All three are per-turn on the provider's side, so choosing one changes the next
 * message and never restarts the agent — the running turn keeps what it was
 * dispatched with. That is why this sits in the composer rather than in settings.
 *
 * The catalog comes from the provider, not from a list in AO. Models are added,
 * renamed, hidden per account and gated by entitlement AO cannot see, so a
 * hardcoded list would be wrong within a week. An agent whose provider cannot
 * enumerate models reports none and the model control hides itself.
 *
 * ACP agents advertise those same dimensions as live session options. They share
 * this chrome rather than each growing a row of pickers: model and thought level
 * club into the left-hand control, mode sits on the right where Codex approvals
 * live, and anything else nests under More. The lists inside are still the
 * provider's; only the grouping of the triggers is AO's.
 */

import { Fragment, useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Shuffle } from "lucide-react";
import {
	OptionMenu,
	OptionMenuContent,
	OptionMenuItem,
	OptionMenuLabel,
	OptionMenuSub,
	OptionMenuSubContent,
	OptionMenuSubTrigger,
	OptionMenuTrigger,
} from "../ui/option-menu";
import { cn } from "../../lib/utils";
import type {
	ApprovalMode,
	ChatConfigOption,
	ChatConfigOptionValue,
	ChatModel,
	ModelReroute,
	TurnSettings,
} from "../../types/conversation";

/**
 * AO's four approval modes, in increasing order of what the agent may do without
 * asking. The hints say what each actually permits rather than naming a policy.
 */
const APPROVAL_COPY: Record<ApprovalMode, { label: string; hint: string }> = {
	default: { label: "Default", hint: "Never asks — the worktree is the boundary" },
	"accept-edits": { label: "Ask outside worktree", hint: "Edits here are free; anything else asks" },
	auto: { label: "Ask when unsure", hint: "The agent decides when to check with you" },
	"bypass-permissions": { label: "Never ask", hint: "No approvals, no sandbox" },
};

const APPROVAL_ORDER: ApprovalMode[] = [
	"default",
	"accept-edits",
	"auto",
	"bypass-permissions",
];

const TRIGGER_CLASS =
	"h-7 gap-1 bg-transparent rounded-lg px-3 text-xs leading-none text-muted-foreground hover:bg-white/5 hover:text-foreground data-[state=open]:bg-white/5 data-[state=open]:text-foreground";

export function TurnSettingsBar({
	models,
	settings,
	reroute,
	onChange,
	configOptions,
	onChangeConfigOption,
	configPending,
	error,
	disabled,
	children,
}: {
	models: ChatModel[];
	settings: TurnSettings;
	/**
	 * The provider answered with a different model than the one chosen. Separate from
	 * `settings` all the way down: settings are what the user asked for, this is what
	 * replied, and folding them together is how the control ends up advertising a
	 * model that is not the one producing the answers.
	 */
	reroute?: ModelReroute;
	onChange?: (next: TurnSettings) => void;
	/** Controls advertised by an ACP agent for this exact live session. */
	configOptions?: ChatConfigOption[];
	onChangeConfigOption?: (
		optionId: string,
		value: ChatConfigOptionValue,
	) => Promise<unknown> | void;
	configPending?: boolean;
	error?: string;
	disabled?: boolean;
	/** Inline controls that belong on the model row, such as queue vs steer. */
	children?: ReactNode;
}) {
	const selected = models.find((model) => model.id === settings.model);
	const fallback = models.find((model) => model.default);
	// The label says what will actually be used: the provider's default is a real
	// answer, not an absence, so it is named rather than shown as "none".
	const chosenLabel = selected?.displayName ?? fallback?.displayName ?? "Provider default";
	const rerouted = reroute
		? models.find((model) => model.id === reroute.toModel)?.displayName ?? reroute.toModel
		: undefined;
	const modelLabel = rerouted ?? chosenLabel;
	const efforts = (selected ?? fallback)?.efforts ?? [];
	const effortLabel =
		settings.reasoningEffort ?? (selected ?? fallback)?.defaultEffort ?? undefined;
	const approvalLabel = APPROVAL_COPY[settings.approvalMode ?? "default"].label;
	const modelGroupLabel = effortLabel
		? `${modelLabel} ${capitalize(effortLabel)}`
		: modelLabel;
	const grouped = partitionConfigOptions(configOptions ?? []);
	const optionDisabled = Boolean(disabled || configPending);
	const applyOption = (optionId: string, value: ChatConfigOptionValue) => {
		if (!onChangeConfigOption) return;
		void Promise.resolve(onChangeConfigOption(optionId, value)).catch(() => {});
	};
	const nativeModelMenu = Boolean(onChange && models.length > 0 && grouped.model.length === 0);
	const clubbedLeft = grouped.model.length > 0 || grouped.effort.length > 0 || grouped.extra.length > 0;
	const modeOption = grouped.mode;
	const showRight = Boolean(onChange || modeOption);

	return (
		<div role="group" aria-label="Turn settings" className="flex min-w-0 flex-1 flex-col gap-0.5">
			<div className="flex h-7 min-w-0 flex-1 items-center justify-between gap-2">
				<div className="flex h-7 min-w-0 flex-wrap items-center gap-0.5">
					{nativeModelMenu && onChange ? (
						<ModelEffortPicker
							models={models}
							settings={settings}
							onChange={onChange}
							disabled={disabled}
							modelLabel={modelLabel}
							groupLabel={modelGroupLabel}
							effortLabel={effortLabel}
							efforts={efforts}
							reroute={reroute}
							rerouted={rerouted}
							chosenLabel={chosenLabel}
							extraOptions={grouped.extra}
							onChangeConfigOption={onChangeConfigOption ? applyOption : undefined}
						/>
					) : null}

					{children}

					{onChangeConfigOption && clubbedLeft && !nativeModelMenu ? (
						<ClubbedConfigPicker
							modelOptions={grouped.model}
							effortOptions={grouped.effort}
							extraOptions={grouped.extra}
							disabled={optionDisabled}
							onChange={applyOption}
						/>
					) : null}
				</div>

				{showRight ? (
					<div className="flex h-7 shrink-0 items-center gap-1">
						{modeOption && onChangeConfigOption ? (
							<ConfigOptionPicker
								option={modeOption}
								disabled={optionDisabled}
								onChange={(value) => applyOption(modeOption.id, value)}
							/>
						) : onChange ? (
							<Picker
								label={approvalLabel}
								title="What the agent may do without asking"
								disabled={disabled}
							>
								<OptionMenuLabel
									className={cn("flex items-baseline justify-between gap-2")}
								>
									<span>Approvals</span>
									<span className="text-[11px] font-normal text-muted-foreground">
										Applies to the next turn
									</span>
								</OptionMenuLabel>
								{APPROVAL_ORDER.map((mode) => (
									<OptionMenuItem
										key={mode}
										onSelect={() => onChange({ ...settings, approvalMode: mode })}
										className={cn("flex-col items-start gap-0.5")}
									>
										<span
											className={cn(
												"text-xs",
												mode === (settings.approvalMode ?? "default")
													? "text-foreground"
													: "text-muted-foreground",
											)}
										>
											{APPROVAL_COPY[mode].label}
										</span>
										<span className="text-[11px] leading-snug text-muted-foreground">
											{APPROVAL_COPY[mode].hint}
										</span>
									</OptionMenuItem>
								))}
							</Picker>
						) : null}
					</div>
				) : null}
			</div>
			{error ? (
				<p role="alert" className="px-1 text-[11px] leading-snug text-destructive">
					{error}
				</p>
			) : null}
		</div>
	);
}

function ModelEffortPicker({
	models,
	settings,
	onChange,
	disabled,
	modelLabel,
	groupLabel,
	effortLabel,
	efforts,
	reroute,
	rerouted,
	chosenLabel,
	extraOptions = [],
	onChangeConfigOption,
}: {
	models: ChatModel[];
	settings: TurnSettings;
	onChange: (next: TurnSettings) => void;
	disabled?: boolean;
	modelLabel: string;
	groupLabel: string;
	effortLabel?: string;
	efforts: string[];
	reroute?: ModelReroute;
	rerouted?: string;
	chosenLabel: string;
	extraOptions?: ChatConfigOption[];
	onChangeConfigOption?: (optionId: string, value: ChatConfigOptionValue) => void;
}) {
	const modelScrollRef = useRef<HTMLDivElement>(null);
	const [modelSubOpen, setModelSubOpen] = useState(false);
	const [canScrollDown, setCanScrollDown] = useState(false);
	const updateScrollCue = useCallback(() => {
		const element = modelScrollRef.current;
		setCanScrollDown(
			Boolean(element && element.scrollHeight - element.scrollTop > element.clientHeight + 1),
		);
	}, []);
	useLayoutEffect(() => {
		if (!modelSubOpen) {
			setCanScrollDown(false);
			return;
		}
		updateScrollCue();
		const element = modelScrollRef.current;
		if (!element || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(updateScrollCue);
		observer.observe(element);
		return () => observer.disconnect();
	}, [modelSubOpen, updateScrollCue, models.length, reroute]);

	return (
		<OptionMenu>
			
				<OptionMenuTrigger
					disabled={disabled}
					aria-label="Model and reasoning effort for the next turn"
					title={
						reroute
							? `The provider answered with ${rerouted} instead of ${reroute.fromModel ?? chosenLabel}${
									reroute.reason ? `: ${reroute.reason}` : ""
								}`
							: "Model and reasoning effort for the next turn"
					}
					className={TRIGGER_CLASS}
				>
					<span className="min-w-0 max-w-[22ch] truncate">{groupLabel}</span>
					{reroute ? (
						// A mark, not a second name. Two truncated model names side by side is
						// less legible than one readable name plus a flag that says it is not
						// the one that was asked for; the tooltip and the menu spell out which.
						<Shuffle
							className="size-3 shrink-0 text-warning"
							aria-label={`Substituted for ${reroute.fromModel ?? chosenLabel}`}
						/>
					) : null}
				</OptionMenuTrigger>
			<OptionMenuContent align="start" >
				<OptionMenuSub onOpenChange={setModelSubOpen}>
					<OptionMenuSubTrigger label="Model" value={modelLabel} />
					{/* Scroll on an inner strip: the surface utility caps height but wheel
					    events do not reliably reach an outer overflow on nested submenus. */}
					<OptionMenuSubContent scrollable>
						<div className="relative grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] overflow-hidden">
							<div
								ref={modelScrollRef}
								className="model-menu-scroll flex min-h-0 flex-col gap-px overflow-y-auto overscroll-contain pb-1"
								onScroll={updateScrollCue}
							>
								{models.map((model) => (
									<OptionMenuItem
										key={model.id}
										active={model.id === settings.model}
										onSelect={() =>
											onChange({ ...settings, model: model.id, reasoningEffort: undefined })
										}
										className={cn("flex-col items-start gap-0.5")}
									>
										<span className="flex w-full items-baseline gap-2">
											<span
												className={cn(
													"text-xs",
													model.id === settings.model
														? "text-foreground"
														: "text-muted-foreground",
												)}
											>
												{model.displayName}
											</span>
											{model.default ? (
												<span className="text-[10px] uppercase tracking-wide text-muted-foreground">
													default
												</span>
											) : null}
										</span>
										{model.description ? (
											<span className="text-[11px] leading-snug text-muted-foreground">
												{model.description}
											</span>
										) : null}
									</OptionMenuItem>
								))}
							</div>
							<div
								className={cn("model-menu-overflow-cue", canScrollDown ? "opacity-100" : "opacity-0")}
								aria-hidden="true"
							/>
						</div>
					</OptionMenuSubContent>
				</OptionMenuSub>

				{efforts.length > 0 ? (
					<OptionMenuSub>
						<OptionMenuSubTrigger label="Effort" value={effortLabel ? capitalize(effortLabel) : "Effort"} />
						<OptionMenuSubContent>
							{efforts.map((effort) => (
								<OptionMenuItem
									key={effort}
									active={effort === settings.reasoningEffort}
									onSelect={() => onChange({ ...settings, reasoningEffort: effort })}
									className={cn("text-xs")}
								>
									<span
										className={cn(
											effort === settings.reasoningEffort
												? "text-foreground"
												: "text-muted-foreground",
										)}
									>
										{capitalize(effort)}
									</span>
								</OptionMenuItem>
							))}
						</OptionMenuSubContent>
					</OptionMenuSub>
				) : null}
				{extraOptions.length > 0 && onChangeConfigOption ? (
					<MoreOptionsSubmenu options={extraOptions} onChange={onChangeConfigOption} />
				) : null}
			</OptionMenuContent>
		</OptionMenu>
	);
}

function ClubbedConfigPicker({
	modelOptions,
	effortOptions,
	extraOptions,
	disabled,
	onChange,
}: {
	modelOptions: ChatConfigOption[];
	effortOptions: ChatConfigOption[];
	extraOptions: ChatConfigOption[];
	disabled?: boolean;
	onChange: (optionId: string, value: ChatConfigOptionValue) => void;
}) {
	const primaryModel = modelOptions[0];
	const primaryEffort = effortOptions[0];
	const modelLabel = primaryModel ? optionCurrentLabel(primaryModel) : undefined;
	const effortLabel = primaryEffort ? optionCurrentLabel(primaryEffort) : undefined;
	const groupLabel = [modelLabel, effortLabel].filter(Boolean).join(" ") || "More";
	const leftCount = modelOptions.length + effortOptions.length + extraOptions.length;
	if (leftCount === 1) {
		const option = primaryModel ?? primaryEffort ?? extraOptions[0];
		if (!option) return null;
		return (
			<ConfigOptionPicker
				option={option}
				disabled={disabled}
				onChange={(value) => onChange(option.id, value)}
			/>
		);
	}

	return (
		<OptionMenu>
			
				<OptionMenuTrigger
					disabled={disabled}
					aria-label="Model and reasoning effort for the next turn"
					title="Model and reasoning effort for the next turn"
					className={TRIGGER_CLASS}
				>
					<span className="min-w-0 max-w-[22ch] truncate">{groupLabel}</span>
				</OptionMenuTrigger>
			<OptionMenuContent align="start" >
				{modelOptions.map((option) => (
					<OptionSubmenu key={option.id} option={option} onChange={onChange} scrollable />
				))}
				{effortOptions.map((option) => (
					<OptionSubmenu key={option.id} option={option} onChange={onChange} />
				))}
				{extraOptions.length > 0 ? (
					<MoreOptionsSubmenu options={extraOptions} onChange={onChange} />
				) : null}
			</OptionMenuContent>
		</OptionMenu>
	);
}

function MoreOptionsSubmenu({
	options,
	onChange,
}: {
	options: ChatConfigOption[];
	onChange: (optionId: string, value: ChatConfigOptionValue) => void;
}) {
	return (
		<OptionMenuSub>
			<OptionMenuSubTrigger label="More" />
			<OptionMenuSubContent >
				{options.map((option) => (
					<OptionSubmenu key={option.id} option={option} onChange={onChange} />
				))}
			</OptionMenuSubContent>
		</OptionMenuSub>
	);
}

function OptionSubmenu({
	option,
	onChange,
	scrollable,
}: {
	option: ChatConfigOption;
	onChange: (optionId: string, value: ChatConfigOptionValue) => void;
	scrollable?: boolean;
}) {
	const current = optionCurrentLabel(option);
	return (
		<OptionMenuSub>
			<OptionMenuSubTrigger label={option.name} value={current} />
			<OptionMenuSubContent scrollable={scrollable}>
				{scrollable ? (
					<div className="relative grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] overflow-hidden">
						<div className="model-menu-scroll flex min-h-0 flex-col gap-px overflow-y-auto overscroll-contain pb-1">
							<ConfigOptionChoices
								option={option}
								onChange={(value) => onChange(option.id, value)}
							/>
						</div>
					</div>
				) : (
					<ConfigOptionChoices
						option={option}
						onChange={(value) => onChange(option.id, value)}
					/>
				)}
			</OptionMenuSubContent>
		</OptionMenuSub>
	);
}

function ConfigOptionPicker({
	option,
	onChange,
	disabled,
}: {
	option: ChatConfigOption;
	onChange: (value: ChatConfigOptionValue) => void;
	disabled?: boolean;
}) {
	return (
		<Picker
			label={optionCurrentLabel(option)}
			title={option.description || option.name}
			disabled={disabled}
		>
			<ConfigOptionChoices option={option} onChange={onChange} />
		</Picker>
	);
}

function ConfigOptionChoices({
	option,
	onChange,
}: {
	option: ChatConfigOption;
	onChange: (value: ChatConfigOptionValue) => void;
}) {
	if (option.type === "boolean") {
		return (
			<>
				{[true, false].map((enabled) => (
					<OptionMenuItem
						key={String(enabled)}
						active={enabled === option.currentBoolean}
						onSelect={() => onChange({ enabled })}
						className={cn("text-xs")}
					>
						<span
							className={cn(
								enabled === option.currentBoolean
									? "text-foreground"
									: "text-muted-foreground",
							)}
						>
							{enabled ? "On" : "Off"}
						</span>
					</OptionMenuItem>
				))}
			</>
		);
	}

	return (
		<>
			{option.choices.map((choice, index) => {
				const previousGroup = index > 0 ? option.choices[index - 1]?.group : undefined;
				return (
					<Fragment key={choice.value}>
						{choice.group && choice.group !== previousGroup ? (
							<OptionMenuLabel className="px-3 pb-1 pt-2 text-[10px] uppercase tracking-wide text-muted-foreground">
								{choice.groupName || choice.group}
							</OptionMenuLabel>
						) : null}
						<OptionMenuItem
							active={choice.value === option.currentValue}
							onSelect={() => onChange({ value: choice.value })}
							className={cn("flex-col items-start gap-0.5")}
						>
							<span className="flex w-full items-baseline gap-2">
								<span
									className={cn(
										"text-xs",
										choice.value === option.currentValue
											? "text-foreground"
											: "text-muted-foreground",
									)}
								>
									{choice.name}
								</span>
							</span>
							{choice.description ? (
								<span className="text-[11px] leading-snug text-muted-foreground">
									{choice.description}
								</span>
							) : null}
						</OptionMenuItem>
					</Fragment>
				);
			})}
		</>
	);
}

/**
 * One dropdown, wearing the chrome Settings uses. These controls are the same
 * kind of thing as a settings row's — pick one of a list — so they are drawn the
 * same way, and the panel sizes itself from the shared surface rather than each
 * picker naming a width of its own.
 */
function Picker({
	label,
	title,
	disabled,
	badge,
	children,
}: {
	label: string;
	title: string;
	disabled?: boolean;
	/** A note that belongs on the trigger, e.g. the model that was overridden. */
	badge?: React.ReactNode;
	children: React.ReactNode;
}) {
	return (
		<OptionMenu>
			
				<OptionMenuTrigger aria-label={title} title={title} disabled={disabled} className={TRIGGER_CLASS}>
					<span className="min-w-0 max-w-[16ch] truncate">{label}</span>
					{badge}
				</OptionMenuTrigger>
			<OptionMenuContent align="end" >
				{children}
			</OptionMenuContent>
		</OptionMenu>
	);
}

function capitalize(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1);
}

function isModelOption(option: ChatConfigOption): boolean {
	return option.category === "model" || option.id === "model" || option.id === "agent";
}

function isEffortOption(option: ChatConfigOption): boolean {
	return option.category === "thought_level" || option.id === "effort";
}

function isModeOption(option: ChatConfigOption): boolean {
	return option.category === "mode" || option.id === "mode";
}

function partitionConfigOptions(options: ChatConfigOption[]): {
	model: ChatConfigOption[];
	effort: ChatConfigOption[];
	mode: ChatConfigOption | undefined;
	extra: ChatConfigOption[];
} {
	const primaryModel: ChatConfigOption[] = [];
	const otherModel: ChatConfigOption[] = [];
	const effort: ChatConfigOption[] = [];
	const extra: ChatConfigOption[] = [];
	let mode: ChatConfigOption | undefined;
	for (const option of options) {
		if (isModelOption(option)) {
			if (option.category === "model" || option.id === "model") primaryModel.push(option);
			else otherModel.push(option);
			continue;
		}
		if (isEffortOption(option)) {
			effort.push(option);
			continue;
		}
		if (isModeOption(option) && !mode) {
			mode = option;
			continue;
		}
		extra.push(option);
	}
	return { model: [...primaryModel, ...otherModel], effort, mode, extra };
}

function optionCurrentLabel(option: ChatConfigOption): string {
	if (option.type === "boolean") return option.currentBoolean ? "On" : "Off";
	return option.choices.find((choice) => choice.value === option.currentValue)?.name
		?? option.currentValue
		?? option.name;
}
