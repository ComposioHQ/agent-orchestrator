"use client";

import * as React from "react";
import { Command as CommandPrimitive } from "cmdk";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Search } from "lucide-react";

import { cn } from "@/lib/utils";

function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        "flex w-full flex-col overflow-hidden rounded-[var(--radius-command-palette)] bg-[var(--color-bg-command-palette)] text-[var(--foreground)] outline-none",
        className,
      )}
      {...props}
    />
  );
}

function CommandDialog({
  title = "Command palette",
  description = "Search projects, sessions, and commands",
  children,
  className,
  commandProps,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root> & {
  title?: string;
  description?: string;
  className?: string;
  commandProps?: React.ComponentProps<typeof CommandPrimitive>;
}) {
  const { className: commandClassName, ...restCommandProps } = commandProps ?? {};
  return (
    <DialogPrimitive.Root data-slot="command-dialog" {...props}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          data-slot="command-dialog-overlay"
          className="dialog-overlay data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out motion-reduce:animate-none"
        />
        <DialogPrimitive.Content
          data-slot="command-dialog-content"
          aria-label={title}
          className={cn(
            "fixed left-1/2 top-1/2 z-[100] w-[min(720px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl border border-[var(--color-border-command-palette)] bg-[var(--color-bg-command-palette)] text-[var(--foreground)] shadow-[var(--shadow-command-palette)] outline-none data-[state=open]:animate-modal-in data-[state=closed]:animate-modal-out motion-reduce:animate-none",
            className,
          )}
        >
          <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">{description}</DialogPrimitive.Description>
          <Command
            className={cn(
              "**:[[cmdk-group-heading]]:px-5 **:[[cmdk-group-heading]]:pt-2.5 **:[[cmdk-group-heading]]:pb-1 **:[[cmdk-group-heading]]:text-[11px] **:[[cmdk-group-heading]]:font-normal **:[[cmdk-group-heading]]:tracking-wide **:[[cmdk-group-heading]]:text-[var(--muted-foreground)] **:[[cmdk-group]]:px-0",
              commandClassName,
            )}
            {...restCommandProps}
          >
            {children}
          </Command>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function CommandInput({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div
      data-slot="command-input-wrapper"
      className="flex items-center gap-2.5 border-b border-[var(--color-border-command-palette)] px-5 py-3"
      cmdk-input-wrapper=""
    >
      <Search className="size-4 shrink-0 text-[var(--color-text-passive)]" aria-hidden="true" />
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          "flex h-6 w-full bg-transparent text-base leading-6 text-[var(--foreground)] caret-[var(--foreground)] outline-none placeholder:text-[var(--color-text-passive)] disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      />
    </div>
  );
}

function CommandList({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn(
        "max-h-[50vh] scroll-py-1 overflow-y-auto overflow-x-hidden overscroll-contain py-1 outline-none",
        className,
      )}
      {...props}
    />
  );
}

function CommandEmpty({ ...props }: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className="py-8 text-center text-sm text-[var(--muted-foreground)]"
      {...props}
    />
  );
}

function CommandGroup({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group data-slot="command-group" className={cn("overflow-hidden pb-1", className)} {...props} />
  );
}

function CommandItem({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        "relative mx-2 flex cursor-default select-none items-center gap-2.5 rounded-md py-1.5 pr-2.5 pl-3.5 text-[13px] leading-[22px] text-[var(--muted-foreground)] outline-none",
        "data-[selected=true]:bg-[var(--color-bg-command-item-active)] data-[selected=true]:text-[var(--foreground)]",
        "data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50",
        "[&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-[var(--color-text-passive)] data-[selected=true]:[&_svg]:text-[var(--foreground)]",
        className,
      )}
      {...props}
    />
  );
}

function CommandFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="command-footer"
      className={cn(
        "flex items-center gap-4 border-t border-[var(--color-border-command-palette)] px-5 pt-3 pb-3 text-sm text-[var(--muted-foreground)]",
        className,
      )}
      {...props}
    />
  );
}

export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandFooter,
};
