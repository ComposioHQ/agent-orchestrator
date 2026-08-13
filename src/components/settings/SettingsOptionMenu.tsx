"use client";

import { ChevronDown } from "lucide-react";
import { type ReactNode, useCallback, useLayoutEffect, useRef, useState } from "react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";
import { useSuppressStrayFocusRing } from "@/hooks/useSuppressStrayFocusRing";

export type SettingsOption<T extends string> = {
  value: T;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
};

export function SettingsOptionMenu<T extends string>({
  value,
  options,
  onChange,
  disabled,
  placeholder,
  menuAlign = "end",
  "aria-label": ariaLabel,
}: {
  value: T;
  options: SettingsOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  placeholder?: string;
  menuAlign?: "start" | "center" | "end";
  "aria-label": string;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const selected = options.find((option) => option.value === value);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollDown, setCanScrollDown] = useState(false);
  const updateScrollCue = useCallback(() => {
    const element = scrollRef.current;
    setCanScrollDown(Boolean(element && element.scrollHeight - element.scrollTop > element.clientHeight + 1));
  }, []);
  useLayoutEffect(() => {
    if (!menuOpen) {
      setCanScrollDown(false);
      return;
    }
    updateScrollCue();
    const element = scrollRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateScrollCue);
    observer.observe(element);
    return () => observer.disconnect();
  }, [menuOpen, updateScrollCue]);
  const onCloseAutoFocus = useSuppressStrayFocusRing(menuOpen);

  return (
    <DropdownMenuPrimitive.Root onOpenChange={setMenuOpen}>
      <DropdownMenuPrimitive.Trigger asChild disabled={disabled}>
        <button
          type="button"
          className="group/sot settings-option-trigger max-w-full min-w-0 bg-[var(--color-bg-settings-trigger)] text-[var(--color-text-settings-trigger)] transition-colors hover:bg-[var(--color-bg-settings-trigger-hover)] data-[state=open]:bg-[var(--color-bg-settings-trigger-hover)] focus:outline-none focus-visible:outline-none focus-visible:ring-0 data-[state=open]:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={ariaLabel}
        >
          <span className="min-w-0 truncate">{selected?.label ?? placeholder}</span>
          <ChevronDown
            className="size-icon-sm shrink-0 transition-transform duration-300 ease-out group-data-[state=open]/sot:rotate-180"
            aria-hidden="true"
          />
        </button>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align={menuAlign}
          alignOffset={0}
          sideOffset={6}
          onCloseAutoFocus={onCloseAutoFocus}
          className="settings-menu-surface z-[100] origin-(--radix-dropdown-menu-content-transform-origin) data-[state=open]:animate-popover-in data-[state=closed]:animate-popover-out"
        >
          <div className="relative min-h-0">
            <div
              ref={scrollRef}
              className="max-h-select-menu-max overflow-y-auto overscroll-contain"
              onScroll={updateScrollCue}
            >
              {options.map((option) => (
                <DropdownMenuPrimitive.Item
                  key={option.value}
                  disabled={option.disabled}
                  onSelect={() => onChange(option.value)}
                  className={cn(
                    "settings-menu-item min-w-0 cursor-default select-none outline-none",
                    "focus:bg-settings-menu-selected focus:text-settings-title",
                    "data-highlighted:bg-settings-menu-selected data-highlighted:text-settings-title",
                    option.value === value && "border-settings-menu bg-settings-menu-selected text-settings-title",
                  )}
                >
                  {option.icon}
                  {option.label}
                </DropdownMenuPrimitive.Item>
              ))}
            </div>
            <div
              className={cn("model-menu-overflow-cue", canScrollDown ? "opacity-100" : "opacity-0")}
              aria-hidden="true"
            />
          </div>
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}
