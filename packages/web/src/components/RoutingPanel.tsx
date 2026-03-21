"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RoutingMode } from "@composio/ao-core";

interface LocalLlmConfig {
  baseUrl: string;
  model: string;
}

interface RoutingConfig {
  mode: RoutingMode;
  localLlm: LocalLlmConfig;
}

type ConnectionStatus = "idle" | "testing" | "ok" | "error";

const MODE_OPTIONS: { value: RoutingMode; label: string; description: string }[] = [
  {
    value: "always-claude",
    label: "Always Claude",
    description: "All sessions use Claude Code (default)",
  },
  {
    value: "smart",
    label: "Smart routing",
    description: "Haiku classifies complexity — simple tasks go to local LLM, complex to Claude",
  },
  {
    value: "always-local",
    label: "Always local LLM",
    description: "All sessions use the local LLM; Claude is not used",
  },
];

interface RoutingPanelProps {
  onClose: () => void;
}

export function RoutingPanel({ onClose }: RoutingPanelProps) {
  const [mode, setMode] = useState<RoutingMode>("always-claude");
  const [baseUrl, setBaseUrl] = useState("http://localhost:11434/v1");
  const [model, setModel] = useState("");
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("idle");
  const [connectionError, setConnectionError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [loading, setLoading] = useState(true);
  const panelRef = useRef<HTMLDivElement>(null);

  // Load current config
  useEffect(() => {
    void fetch("/api/routing")
      .then((r) => r.json())
      .then((data: { routing?: RoutingConfig }) => {
        if (data.routing) {
          setMode(data.routing.mode);
          setBaseUrl(data.routing.localLlm.baseUrl);
          setModel(data.routing.localLlm.model);
        }
      })
      .catch(() => {
        // silently ignore — use defaults
      })
      .finally(() => setLoading(false));
  }, []);

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const showLlmSettings = mode === "smart" || mode === "always-local";

  const fetchModels = useCallback(async (url: string) => {
    try {
      const res = await fetch(`${url.replace(/\/$/, "")}/models`);
      if (!res.ok) return [];
      const data = (await res.json()) as { data?: { id: string }[] };
      return data.data?.map((m) => m.id) ?? [];
    } catch {
      return [];
    }
  }, []);

  const handleTestConnection = useCallback(async () => {
    setConnectionStatus("testing");
    setConnectionError("");
    try {
      const res = await fetch(`${baseUrl.replace(/\/$/, "")}/models`);
      if (!res.ok) {
        setConnectionStatus("error");
        setConnectionError(`HTTP ${res.status}`);
        return;
      }
      const data = (await res.json()) as { data?: { id: string }[] };
      const models = data.data?.map((m) => m.id) ?? [];
      setAvailableModels(models);
      setConnectionStatus("ok");
      if (models.length > 0 && !model) {
        setModel(models[0] ?? "");
      }
    } catch (err) {
      setConnectionStatus("error");
      setConnectionError(err instanceof Error ? err.message : "Connection failed");
    }
  }, [baseUrl, model]);

  // Auto-fetch models when baseUrl or mode changes (model intentionally excluded from deps
  // to avoid infinite loop when we auto-set model from the fetched list)
  const modelRef = useRef(model);
  modelRef.current = model;

  useEffect(() => {
    if (!showLlmSettings) return;
    void fetchModels(baseUrl).then((models) => {
      if (models.length > 0) {
        setAvailableModels(models);
        setConnectionStatus("ok");
        if (!modelRef.current) setModel(models[0] ?? "");
      }
    });
  }, [baseUrl, showLlmSettings, fetchModels]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError("");
    setSaveSuccess(false);
    try {
      const res = await fetch("/api/routing", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          routing: { mode, localLlm: { baseUrl, model } },
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? `HTTP ${res.status}`);
      }
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2000);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }, [mode, baseUrl, model]);

  return (
    <div
      ref={panelRef}
      className="absolute right-0 top-full z-50 mt-2 w-[400px] rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-primary)] shadow-lg"
      role="dialog"
      aria-label="LLM Routing Settings"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] px-4 py-3">
        <span className="text-[12px] font-semibold text-[var(--color-text-primary)]">
          LLM Routing
        </span>
        <button
          onClick={onClose}
          className="text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]"
          aria-label="Close"
        >
          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="p-4 space-y-4">
        {loading ? (
          <p className="text-[11px] text-[var(--color-text-tertiary)]">Loading…</p>
        ) : (
          <>
            {/* Mode selector */}
            <fieldset>
              <legend className="mb-2 text-[11px] font-medium text-[var(--color-text-secondary)]">
                Routing mode
              </legend>
              <div className="space-y-2">
                {MODE_OPTIONS.map((opt) => (
                  <label
                    key={opt.value}
                    className={`flex cursor-pointer items-start gap-2.5 rounded border px-3 py-2.5 transition-colors ${
                      mode === opt.value
                        ? "border-[var(--color-accent)] bg-[rgba(99,102,241,0.05)]"
                        : "border-[var(--color-border-subtle)] hover:border-[var(--color-border-default)]"
                    }`}
                  >
                    <input
                      type="radio"
                      name="routing-mode"
                      value={opt.value}
                      checked={mode === opt.value}
                      onChange={() => setMode(opt.value)}
                      className="mt-0.5 shrink-0 accent-[var(--color-accent)]"
                    />
                    <div>
                      <div className="text-[11px] font-medium text-[var(--color-text-primary)]">
                        {opt.label}
                      </div>
                      <div className="text-[10px] text-[var(--color-text-tertiary)]">
                        {opt.description}
                      </div>
                    </div>
                  </label>
                ))}
              </div>
            </fieldset>

            {/* LLM settings — shown when mode is smart or always-local */}
            {showLlmSettings && (
              <div className="space-y-3 rounded border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-3">
                <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-tertiary)]">
                  Local LLM endpoint
                </p>

                {/* Base URL */}
                <div>
                  <label className="mb-1 block text-[11px] text-[var(--color-text-secondary)]">
                    Base URL
                  </label>
                  <input
                    type="text"
                    value={baseUrl}
                    onChange={(e) => {
                      setBaseUrl(e.target.value);
                      setConnectionStatus("idle");
                    }}
                    placeholder="http://localhost:11434/v1"
                    className="w-full rounded border border-[var(--color-border-subtle)] bg-[var(--color-bg-primary)] px-2.5 py-1.5 text-[11px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
                  />
                </div>

                {/* Model */}
                <div>
                  <label className="mb-1 block text-[11px] text-[var(--color-text-secondary)]">
                    Model
                  </label>
                  {availableModels.length > 0 ? (
                    <select
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                      className="w-full rounded border border-[var(--color-border-subtle)] bg-[var(--color-bg-primary)] px-2.5 py-1.5 text-[11px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
                    >
                      {availableModels.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                      placeholder="e.g. llama3, mistral"
                      className="w-full rounded border border-[var(--color-border-subtle)] bg-[var(--color-bg-primary)] px-2.5 py-1.5 text-[11px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
                    />
                  )}
                </div>

                {/* Test connection */}
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => void handleTestConnection()}
                    disabled={connectionStatus === "testing"}
                    className="rounded border border-[var(--color-border-subtle)] px-2.5 py-1 text-[10px] text-[var(--color-text-secondary)] hover:border-[var(--color-border-default)] hover:text-[var(--color-text-primary)] disabled:opacity-50"
                  >
                    {connectionStatus === "testing" ? "Testing…" : "Test connection"}
                  </button>
                  {connectionStatus === "ok" && (
                    <span className="flex items-center gap-1 text-[10px] text-[var(--color-status-success)]">
                      <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 20 20">
                        <path
                          fillRule="evenodd"
                          d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                          clipRule="evenodd"
                        />
                      </svg>
                      Connected
                      {availableModels.length > 0 && (
                        <span className="opacity-60">({availableModels.length} models)</span>
                      )}
                    </span>
                  )}
                  {connectionStatus === "error" && (
                    <span className="text-[10px] text-[var(--color-status-error)]">
                      {connectionError || "Unreachable"}
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* Save */}
            <div className="flex items-center justify-between pt-1">
              <div className="text-[10px]">
                {saveError && (
                  <span className="text-[var(--color-status-error)]">{saveError}</span>
                )}
                {saveSuccess && (
                  <span className="text-[var(--color-status-success)]">Saved</span>
                )}
              </div>
              <button
                onClick={() => void handleSave()}
                disabled={saving}
                className="rounded bg-[var(--color-accent)] px-3 py-1.5 text-[11px] font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
