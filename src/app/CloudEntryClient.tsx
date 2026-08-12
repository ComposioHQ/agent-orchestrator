"use client";

import type { FormEvent, InputHTMLAttributes } from "react";
import { useState } from "react";

import { AOLogo } from "./AOLogo";
import { PrismLogoGrid } from "./auth/PrismLogoGrid";

type LocalAuthView = "sign-in" | "create-account";

export function CloudEntryClient({ mode }: { mode: "local" | "staging" }) {
  const [view, setView] = useState<LocalAuthView>("sign-in");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submitLocalAuth = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    const form = new FormData(event.currentTarget);
    const body =
      view === "sign-in"
        ? {
            email: form.get("email"),
            password: form.get("password"),
          }
        : {
            email: form.get("email"),
            password: form.get("password"),
            displayName: form.get("displayName"),
            orgName: form.get("orgName"),
            orgSlug: form.get("orgSlug"),
          };
    try {
      const response = await fetch(
        `/api/cloud/v1/auth/local/${view === "sign-in" ? "login" : "register"}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          message?: string;
        } | null;
        throw new Error(payload?.message || "Authentication failed.");
      }
      window.location.assign("/app");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Authentication failed.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="grid min-h-dvh bg-[#0a0b0d] text-[#f4f5f7] lg:grid-cols-[minmax(420px,0.82fr)_minmax(520px,1.18fr)]">
      <section className="relative flex min-h-dvh animate-[auth-form-enter_600ms_cubic-bezier(0.22,1,0.36,1)_both] flex-col border-white/[0.07] px-6 py-6 motion-reduce:animate-none sm:px-10 sm:py-8 lg:border-r lg:px-[clamp(3rem,7vw,7.5rem)]">
        <AOLogo />

        <div className="my-auto w-full max-w-[380px] py-12">
          <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-[#646a73]">
            <span>AO Cloud</span>
            <span aria-hidden="true">/</span>
            <span>{mode === "local" ? "Local development" : "Staging"}</span>
          </div>
          <h1 className="mt-3 text-[clamp(2rem,4vw,3.25rem)] font-medium leading-none tracking-[-0.055em]">
            Your agents.
            <br />
            One workspace.
          </h1>

          {mode === "staging" ? (
            <>
              <p className="mt-5 max-w-sm text-sm leading-6 text-[#9ba1aa]">
                Sign in securely with WorkOS to open the hosted staging board.
              </p>
              <a
                className="mt-10 inline-flex h-11 w-full items-center justify-center rounded-md bg-[#f4f5f7] px-4 text-sm font-medium text-[#0a0b0d] transition-[background-color,transform] hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8bb5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0b0d] active:scale-[0.99] motion-reduce:transform-none"
                href="/sign-in"
              >
                Continue with WorkOS
              </a>
            </>
          ) : (
            <form className="mt-8 space-y-3" onSubmit={submitLocalAuth}>
              <p className="mb-5 text-sm leading-6 text-[#9ba1aa]">
                Development-only credentials stay in your local PostgreSQL
                database and are never sent to WorkOS.
              </p>
              {view === "create-account" ? (
                <>
                  <AuthField
                    autoComplete="name"
                    label="Display name"
                    name="displayName"
                    required
                  />
                  <AuthField
                    autoComplete="organization"
                    label="Organization name"
                    name="orgName"
                    required
                  />
                  <AuthField
                    autoComplete="off"
                    label="Organization slug"
                    name="orgSlug"
                    pattern="[a-z0-9][a-z0-9-]{1,62}"
                    placeholder="my-team"
                    required
                  />
                </>
              ) : null}
              <AuthField
                autoComplete="email"
                label="Email"
                name="email"
                type="email"
                required
              />
              <AuthField
                autoComplete={
                  view === "sign-in" ? "current-password" : "new-password"
                }
                label="Password"
                minLength={12}
                name="password"
                type="password"
                required
              />
              {error ? (
                <p className="text-xs leading-5 text-[#ef6b73]" role="alert">
                  {error}
                </p>
              ) : null}
              <button
                className="mt-3 inline-flex h-11 w-full items-center justify-center rounded-md bg-[#f4f5f7] px-4 text-sm font-medium text-[#0a0b0d] transition-colors hover:bg-white disabled:cursor-wait disabled:opacity-60"
                disabled={submitting}
                type="submit"
              >
                {submitting
                  ? "Please wait…"
                  : view === "sign-in"
                    ? "Sign in locally"
                    : "Create local account"}
              </button>
              <button
                className="inline-flex h-9 w-full items-center justify-center text-xs text-[#9ba1aa] transition-colors hover:text-[#f4f5f7]"
                onClick={() =>
                  setView((current) =>
                    current === "sign-in" ? "create-account" : "sign-in",
                  )
                }
                type="button"
              >
                {view === "sign-in"
                  ? "Need a local account?"
                  : "Already have a local account?"}
              </button>
            </form>
          )}
        </div>

        <p className="text-[11px] leading-5 text-[#646a73]">
          Agent execution runs in an isolated sandbox for each session.
        </p>
      </section>

      <aside
        className="hidden min-h-dvh lg:block"
        aria-label="Agent Orchestrator"
      >
        <PrismLogoGrid />
      </aside>
    </main>
  );
}

function AuthField({
  label,
  ...props
}: { label: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs text-[#9ba1aa]">{label}</span>
      <input
        {...props}
        aria-label={label}
        className="h-10 w-full rounded-md border border-white/[0.1] bg-white/[0.035] px-3 text-sm text-[#f4f5f7] outline-none transition-colors placeholder:text-[#646a73] focus:border-[#4d8dff]"
      />
    </label>
  );
}
