"use client";

interface AgentSettingsProps {
  defaultAgent?: string;
  defaultPermissions?: string;
  workspaceStrategy?: string;
}

export function AgentSettings({
  defaultAgent = "claude-code",
  defaultPermissions = "default",
  workspaceStrategy = "worktree",
}: AgentSettingsProps) {
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-[17px] font-semibold text-[var(--color-text-primary)]">Agent Defaults</h1>
        <p className="mt-1 text-[14px] text-[var(--color-text-secondary)]">
          Default settings for new agent sessions. Currently read-only — edit via project config YAML.
        </p>
      </div>

      <div className="space-y-3">
        <SettingCard
          label="Default Agent"
          value={defaultAgent}
          description="The agent runtime used for new sessions."
        />
        <SettingCard
          label="Default Permissions"
          value={defaultPermissions}
          description="Permission level for new agent sessions (permissionless, default, auto-edit, suggest)."
        />
        <SettingCard
          label="Workspace Strategy"
          value={workspaceStrategy}
          description="How the agent's working copy is created (worktree, clone, copy)."
        />
      </div>

      <p className="mt-6 text-[12px] text-[var(--color-text-tertiary)]">
        To change these defaults, edit the <code className="bg-[var(--color-bg-subtle)] px-1 py-0.5" style={{ fontFamily: "var(--font-mono)" }}>agent</code> section in your project&apos;s <code className="bg-[var(--color-bg-subtle)] px-1 py-0.5" style={{ fontFamily: "var(--font-mono)" }}>ao.yaml</code> config file.
      </p>
    </div>
  );
}

function SettingCard({ label, value, description }: { label: string; value: string; description: string }) {
  return (
    <div className="rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-5 py-4">
      <div className="flex items-center justify-between">
        <span className="text-[14px] font-semibold text-[var(--color-text-primary)]">{label}</span>
        <span
          className="border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] px-2.5 py-1 text-[12px] font-medium text-[var(--color-text-primary)]"
          style={{ fontFamily: "var(--font-mono)", borderRadius: "2px" }}
        >
          {value}
        </span>
      </div>
      <p className="mt-2 text-[12px] text-[var(--color-text-secondary)]">{description}</p>
    </div>
  );
}
