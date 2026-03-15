import type { RuntimeHandle } from "@composio/ao-core";

function getProcessPid(handle: RuntimeHandle | null | undefined): number | null {
  const pid = handle?.data?.["pid"];
  return typeof pid === "number" ? pid : null;
}

export function formatAttachHint(
  handle: RuntimeHandle | null | undefined,
  fallbackTarget: string,
): string {
  const runtimeName = handle?.runtimeName;
  const target = handle?.id ?? fallbackTarget;

  if (!runtimeName || runtimeName === "tmux") {
    return `tmux attach -t ${target}`;
  }

  if (runtimeName === "process") {
    const pid = getProcessPid(handle);
    return pid === null ? "process runtime (no interactive attach command)" : `process runtime (PID ${pid})`;
  }

  return `${runtimeName} runtime (${target})`;
}

