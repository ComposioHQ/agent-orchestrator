import * as React from "react";
import { clsx } from "clsx";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type = "text", ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      data-slot="input"
      className={clsx(
        "h-10 w-full min-w-0 rounded-md border border-[var(--border)] bg-[var(--input)] px-3 text-sm text-[var(--foreground)] outline-none transition-[color,box-shadow,border-color] placeholder:text-[var(--muted-foreground)] focus-visible:border-[var(--ring)] focus-visible:ring-3 focus-visible:ring-[var(--ring)]/30 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-[var(--destructive)] aria-invalid:ring-3 aria-invalid:ring-[var(--destructive)]/20",
        className,
      )}
      {...props}
    />
  ),
);

Input.displayName = "Input";
