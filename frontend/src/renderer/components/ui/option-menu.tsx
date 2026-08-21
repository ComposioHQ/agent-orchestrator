import { forwardRef, type ButtonHTMLAttributes } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import { cn } from "../../lib/utils";

const SURFACE =
	"settings-menu-surface min-w-[14rem] rounded-(--radius-settings-panel) border-settings-menu bg-settings-menu p-1 gap-px";

const ROW =
	"min-w-0 cursor-default rounded-[10px] px-3 py-2 outline-none whitespace-nowrap focus:bg-settings-menu-selected focus:text-settings-title focus:text-foreground data-highlighted:bg-settings-menu-selected data-highlighted:text-settings-title data-highlighted:text-foreground data-[active=true]:bg-settings-menu-selected data-[active=true]:text-foreground";

const LABEL =
	"px-3 py-2 text-[length:var(--font-size-base)] font-normal tracking-normal text-settings-muted";

/**
 * The quiet filled trigger both this menu and the Settings pickers wear —
 * everything except the `group/*` token, which each owner names for itself so
 * its own chevron can key off it. Shared because the two are meant to be the
 * same control: a visual tweak here should never need making twice.
 */
export const MENU_TRIGGER_CHROME =
	"settings-option-trigger max-w-full min-w-0 bg-[var(--color-bg-settings-trigger)] text-[var(--color-text-settings-trigger)] transition-colors hover:bg-[var(--color-bg-settings-trigger-hover)] hover:text-[var(--color-text-settings-trigger)] data-[state=open]:bg-[var(--color-bg-settings-trigger-hover)] focus:outline-none focus-visible:outline-none focus-visible:ring-0 data-[state=open]:outline-none data-[state=open]:ring-0 disabled:cursor-not-allowed disabled:opacity-50";

const TRIGGER = cn("group/option-menu-trigger", MENU_TRIGGER_CHROME);

// ---------------------------------------------------------------------------
// Root — re-export for convenience
// ---------------------------------------------------------------------------

export const OptionMenu = DropdownMenuPrimitive.Root;

// ---------------------------------------------------------------------------
// Trigger
// ---------------------------------------------------------------------------

export const OptionMenuTrigger = forwardRef<
	HTMLButtonElement,
	ButtonHTMLAttributes<HTMLButtonElement>
>(function OptionMenuTrigger({ className, children, ...props }, ref) {
	return (
		<DropdownMenuPrimitive.Trigger asChild>
			<button ref={ref} type="button" className={cn(TRIGGER, className)} {...props}>
				{children}
				<ChevronDown
					className="size-icon-sm shrink-0 transition-transform duration-300 ease-out group-data-[state=open]/option-menu-trigger:rotate-180"
					aria-hidden="true"
				/>
			</button>
		</DropdownMenuPrimitive.Trigger>
	);
});

// ---------------------------------------------------------------------------
// Content (the panel)
// ---------------------------------------------------------------------------

export function OptionMenuContent({
	className,
	sideOffset = 6,
	children,
	...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
	return (
		<DropdownMenuPrimitive.Portal>
			<DropdownMenuPrimitive.Content
				sideOffset={sideOffset}
				collisionPadding={16}
				className={cn(
					"z-overlay",
					SURFACE,
					"origin-(--radix-dropdown-menu-content-transform-origin)",
					"data-[state=open]:animate-popover-in data-[state=closed]:animate-popover-out",
					className,
				)}
				{...props}
			>
				{children}
			</DropdownMenuPrimitive.Content>
		</DropdownMenuPrimitive.Portal>
	);
}

// ---------------------------------------------------------------------------
// Label
// ---------------------------------------------------------------------------

export function OptionMenuLabel({
	className,
	...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label>) {
	return (
		<DropdownMenuPrimitive.Label
			className={cn(LABEL, className)}
			{...props}
		/>
	);
}

// ---------------------------------------------------------------------------
// Item
// ---------------------------------------------------------------------------

export function OptionMenuItem({
	className,
	active,
	...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & { active?: boolean }) {
	return (
		<DropdownMenuPrimitive.Item
			data-active={active || undefined}
			className={cn(ROW, "flex items-center", className)}
			{...props}
		/>
	);
}

// ---------------------------------------------------------------------------
// Submenu — trigger row + subcontent panel
// ---------------------------------------------------------------------------

export const OptionMenuSub = DropdownMenuPrimitive.Sub;

export function OptionMenuSubTrigger({
	className,
	label,
	value,
	children,
	...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubTrigger> & {
	label?: string;
	value?: string;
}) {
	return (
		<DropdownMenuPrimitive.SubTrigger
			className={cn(ROW, "flex items-center justify-between gap-3 text-xs text-foreground data-[state=open]:bg-settings-menu-selected data-[state=open]:text-foreground", className)}
			// Stop the click reaching the composer's click-to-focus handler without
			// calling preventDefault, which Radix's composeEventHandlers reads as a
			// signal to skip its own open/close handling.
			onClick={(e) => e.stopPropagation()}
			{...props}
		>
			{children ?? (
				<>
					<span>{label}</span>
					<span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
						<span className="min-w-0 truncate">{value}</span>
						<ChevronRight aria-hidden="true" className="size-3 shrink-0" />
					</span>
				</>
			)}
		</DropdownMenuPrimitive.SubTrigger>
	);
}

export function OptionMenuSubContent({
	className,
	sideOffset = 6,
	alignOffset = -4,
	scrollable,
	children,
	...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent> & {
	scrollable?: boolean;
}) {
	return (
		<DropdownMenuPrimitive.SubContent
			sideOffset={sideOffset}
			alignOffset={alignOffset}
			collisionPadding={16}
			className={cn(
				"z-overlay",
				SURFACE,
				"origin-(--radix-dropdown-menu-content-transform-origin)",
				"data-[state=open]:animate-popover-in",
				scrollable && "max-h-select-menu-max! overflow-hidden!",
				className,
			)}
			{...props}
		>
			{children}
		</DropdownMenuPrimitive.SubContent>
	);
}
