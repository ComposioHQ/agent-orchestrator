"use client";

import { useState, useEffect } from "react";

interface IntegrationStatus {
  name: string;
  connected: boolean;
  details?: string;
}

export function IntegrationSettings() {
  const [integrations, setIntegrations] = useState<IntegrationStatus[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/integrations")
      .then((res) => res.json())
      .then((data: { integrations?: IntegrationStatus[] }) => {
        setIntegrations(data.integrations ?? []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-[17px] font-semibold text-[var(--color-text-primary)]">Integrations</h1>
        <p className="mt-1 text-[14px] text-[var(--color-text-secondary)]">
          Connection status for external services.
        </p>
      </div>

      {loading ? (
        <div className="text-[13px] text-[var(--color-text-tertiary)]">Checking connections...</div>
      ) : (
        <div className="space-y-3">
          {integrations.map((integration) => (
            <div
              key={integration.name}
              className="rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-5 py-4"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span
                    className="h-2.5 w-2.5 rounded-full"
                    style={{
                      background: integration.connected ? "var(--color-status-ready)" : "var(--color-text-tertiary)",
                    }}
                  />
                  <span className="text-[14px] font-semibold text-[var(--color-text-primary)]">
                    {integration.name}
                  </span>
                </div>
                <span
                  className="text-[12px] font-medium"
                  style={{
                    color: integration.connected ? "var(--color-status-ready)" : "var(--color-text-tertiary)",
                  }}
                >
                  {integration.connected ? "Connected" : "Disconnected"}
                </span>
              </div>
              {integration.details && (
                <p className="mt-2 text-[12px] text-[var(--color-text-secondary)]">{integration.details}</p>
              )}
              {!integration.connected && (
                <p className="mt-2 text-[11px] text-[var(--color-text-tertiary)]">
                  Configure via CLI: <code className="bg-[var(--color-bg-subtle)] px-1 py-0.5 text-[11px]" style={{ fontFamily: "var(--font-mono)" }}>
                    {integration.name === "GitHub" ? "gh auth login" : "export LINEAR_API_KEY=..."}
                  </code>
                </p>
              )}
            </div>
          ))}
          {integrations.length === 0 && (
            <p className="text-[13px] text-[var(--color-text-secondary)]">No integrations detected.</p>
          )}
        </div>
      )}
    </div>
  );
}
