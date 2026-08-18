"use client";

import { ArrowLeft, ArrowRight, Globe2, RefreshCw } from "lucide-react";
import { type FormEvent, useMemo, useRef, useState } from "react";

function normalizeBrowserURL(value: string): URL {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Enter a URL to open it in this VM.");
  try {
    return new URL(trimmed);
  } catch {
    const local = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(trimmed);
    return new URL(`${local ? "http" : "https"}://${trimmed}`);
  }
}

function browserProxyURL(organizationId: string, sessionId: string, target: URL): string {
  const origin = window.btoa(target.origin)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  const path = target.pathname.replace(/^\//, "");
  return `/api/cloud/v1/orgs/${encodeURIComponent(organizationId)}/sessions/${encodeURIComponent(sessionId)}/browser/${origin}/${path}${target.search}`;
}

export function CloudBrowser({
  organizationId,
  sessionId,
}: {
  organizationId: string;
  sessionId: string;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [address, setAddress] = useState("");
  const [source, setSource] = useState("");
  const [error, setError] = useState("");
  const hasPage = source !== "";
  const frameKey = useMemo(() => source, [source]);

  const navigate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      const target = normalizeBrowserURL(address);
      setAddress(target.toString());
      setSource(browserProxyURL(organizationId, sessionId, target));
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not open that URL.");
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col" role="tabpanel">
      <form
        className="flex h-10 shrink-0 items-center gap-1 border-b border-[var(--color-border-strong)] bg-[var(--color-bg-secondary)] px-2"
        onSubmit={navigate}
      >
        <button
          aria-label="Back"
          className="grid size-7 place-items-center rounded text-[var(--color-text-passive)] hover:bg-[var(--color-interactive-hover)] hover:text-[var(--foreground)] disabled:opacity-40"
          disabled={!hasPage}
          onClick={() => frame.current?.contentWindow?.history.back()}
          type="button"
        >
          <ArrowLeft className="size-3.5" />
        </button>
        <button
          aria-label="Forward"
          className="grid size-7 place-items-center rounded text-[var(--color-text-passive)] hover:bg-[var(--color-interactive-hover)] hover:text-[var(--foreground)] disabled:opacity-40"
          disabled={!hasPage}
          onClick={() => frame.current?.contentWindow?.history.forward()}
          type="button"
        >
          <ArrowRight className="size-3.5" />
        </button>
        <button
          aria-label="Reload"
          className="grid size-7 place-items-center rounded text-[var(--color-text-passive)] hover:bg-[var(--color-interactive-hover)] hover:text-[var(--foreground)] disabled:opacity-40"
          disabled={!hasPage}
          onClick={() => setSource((current) => `${current}${current.includes("?") ? "&" : "?"}_=${Date.now()}`)}
          type="button"
        >
          <RefreshCw className="size-3.5" />
        </button>
        <div className="relative min-w-0 flex-1">
          <Globe2 className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-[var(--color-text-passive)]" />
          <input
            aria-label="VM browser URL"
            className="h-7 w-full rounded border border-[var(--color-border-strong)] bg-[var(--color-bg-primary)] pl-7 pr-2 font-mono text-[11px] outline-none placeholder:text-[var(--color-text-passive)] focus:border-[var(--color-accent-strong)]"
            onChange={(event) => setAddress(event.target.value)}
            placeholder="localhost:3000 or https://example.com"
            value={address}
          />
        </div>
      </form>
      {error ? <p className="border-b border-[var(--error)]/30 bg-[var(--error)]/10 px-3 py-2 text-xs text-[var(--error)]">{error}</p> : null}
      {hasPage ? (
        <iframe
          className="min-h-0 flex-1 border-0 bg-white"
          key={frameKey}
          ref={frame}
          referrerPolicy="no-referrer"
          sandbox="allow-downloads allow-forms allow-modals allow-scripts"
          src={source}
          title="VM browser"
        />
      ) : (
        <div className="grid min-h-0 flex-1 place-items-center p-6 text-center text-xs leading-5 text-[var(--color-text-passive)]">
          Enter a URL to open it from this VM. <code className="ml-1 rounded bg-[var(--color-bg-secondary)] px-1 py-0.5">localhost:3000</code> opens the VM&apos;s local server.
        </div>
      )}
    </div>
  );
}
