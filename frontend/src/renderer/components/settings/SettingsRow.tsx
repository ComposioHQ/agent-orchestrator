import { ChevronDown, ChevronRight, Pencil, type LucideIcon } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/utils";

function SettingsRowLabel({ icon: Icon, label }: { icon?: LucideIcon; label: string }) {
	return (
		<div className="flex shrink-0 items-center gap-(--size-settings-row-icon-gap)">
			{Icon ? <Icon className="size-icon-lg shrink-0 text-settings-muted" aria-hidden="true" /> : null}
			<span className="whitespace-nowrap text-sm leading-5 text-settings-label">{label}</span>
		</div>
	);
}

/** Settings row bar: tokenized height, radius, padding, and icon gap. */
export function SettingsRow({
	icon,
	label,
	children,
	className,
}: {
	icon?: LucideIcon;
	label: string;
	children: ReactNode;
	className?: string;
}) {
	return (
		<div className={cn("settings-row-bar", className)}>
			<SettingsRowLabel icon={icon} label={label} />
			<div className="flex min-w-0 flex-1 items-center justify-end">{children}</div>
		</div>
	);
}

/** Idle value + pencil; the input bar appears only after click. */
export function SettingsInlineInput({
	id,
	label,
	value,
	onChange,
	placeholder,
	className,
}: {
	id: string;
	label: string;
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	className?: string;
}) {
	const { t } = useTranslation();
	const [editing, setEditing] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (!editing) return;
		const input = inputRef.current;
		if (!input) return;
		input.focus();
		input.select();
	}, [editing]);

	const finishEditing = () => setEditing(false);

	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Enter") {
			event.preventDefault();
			finishEditing();
			return;
		}
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			finishEditing();
		}
	};

	if (!editing) {
		return (
			<button
				type="button"
				className={cn("settings-inline-edit-trigger", className)}
				aria-label={t("settings.field.edit", { label })}
				onClick={() => setEditing(true)}
			>
				<span className="settings-row-value" title={value || placeholder}>
					{value || placeholder}
				</span>
				<Pencil className="settings-inline-edit-icon" aria-hidden="true" />
			</button>
		);
	}

	return (
		<input
			ref={inputRef}
			id={id}
			aria-label={label}
			className={cn("settings-inline-edit-input", className)}
			value={value}
			onChange={(event) => onChange(event.target.value)}
			onBlur={finishEditing}
			onKeyDown={onKeyDown}
			placeholder={placeholder}
		/>
	);
}

export function SettingsInputRow({
	icon,
	label,
	id,
	value,
	onChange,
	placeholder,
}: {
	icon?: LucideIcon;
	label: string;
	id: string;
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
}) {
	return (
		<SettingsRow icon={icon} label={label}>
			<SettingsInlineInput id={id} label={label} value={value} onChange={onChange} placeholder={placeholder} />
		</SettingsRow>
	);
}

export function SettingsLinkRow({
	icon,
	label,
	onClick,
}: {
	icon?: LucideIcon;
	label: string;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="settings-row-bar settings-link-row w-full text-left transition-colors hover:bg-settings-menu-selected focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
		>
			<SettingsRowLabel icon={icon} label={label} />
			<ChevronRight className="size-icon-base shrink-0 text-settings-muted" aria-hidden="true" />
		</button>
	);
}

export function SettingsExpandableRow({
	icon,
	label,
	children,
	defaultOpen = false,
}: {
	icon?: LucideIcon;
	label: string;
	children: ReactNode | ((open: boolean) => ReactNode);
	defaultOpen?: boolean;
}) {
	const [open, setOpen] = useState(defaultOpen);
	const containerRef = useRef<HTMLDivElement>(null);
	const content = typeof children === "function" ? children(open) : children;

	const scrollIntoViewIfNeeded = () => {
		const el = containerRef.current;
		if (!el) return;
		requestAnimationFrame(() => {
			const scrollParent = el.closest<HTMLElement>("[style*='overflow'], [class*='overflow']") ?? el.parentElement;
			if (!scrollParent) return;
			const targetTop = el.offsetTop - scrollParent.offsetTop;
			const start = scrollParent.scrollTop;
			const distance = targetTop - start;
			if (Math.abs(distance) < 2) return;
			const duration = 300;
			const startTime = performance.now();
			const step = (now: number) => {
				const t = Math.min((now - startTime) / duration, 1);
				const ease = t * (2 - t);
				scrollParent.scrollTop = start + distance * ease;
				if (t < 1) requestAnimationFrame(step);
			};
			requestAnimationFrame(step);
		});
	};

	return (
		<div
			ref={containerRef}
			className={cn(
				"flex flex-col rounded-md bg-[var(--color-bg-settings-row)] transition-colors",
				open ? "bg-[var(--color-bg-settings-row-hover)]" : "hover:bg-[var(--color-bg-settings-row-hover)]",
			)}
		>
			<button
				type="button"
				onClick={() => {
					scrollIntoViewIfNeeded();
					setOpen(!open);
				}}
				aria-expanded={open}
				className="flex h-[var(--size-settings-row)] min-h-[var(--size-settings-row)] w-full items-center justify-between gap-[var(--size-settings-row-icon-gap)] bg-transparent px-[var(--size-settings-row-padding)] py-[var(--size-settings-row-padding)] text-left focus-visible:rounded-md focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
			>
				<SettingsRowLabel icon={icon} label={label} />
				<ChevronDown
					className={cn(
						"size-icon-base shrink-0 text-settings-muted transition-transform duration-200",
						!open && "-rotate-90",
					)}
					aria-hidden="true"
				/>
			</button>
			{/* Content stays mounted while collapsed (hidden + inert) so the first
			    expand only animates height — mounting a heavy subtree (QR render,
			    queries) mid-animation is what makes first-open janky. Children get
			    `open` via the render prop to gate network work until visible. */}
			<motion.div
				initial={false}
				animate={{ height: open ? "auto" : 0, opacity: open ? 1 : 0 }}
				transition={{
					height: { duration: 0.15, ease: [0.23, 1, 0.32, 1] },
					opacity: { duration: 0.1, ease: "easeOut" },
				}}
				className="overflow-hidden"
				aria-hidden={!open}
				inert={!open || undefined}
			>
				{/* pb matches px so content (e.g. the QR panel) sits equidistant
				    from the right and bottom edges. */}
				<div className="h-fit px-3 pb-3">
					{content}
				</div>
			</motion.div>
		</div>
	);
}
