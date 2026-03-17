import { spawn } from "node:child_process";
import type { RuntimeHandle, Session } from "@composio/ao-core";
import { formatAge } from "./format.js";
import { getTmuxActivity } from "./shell.js";

function defaultHandle(sessionId: string): RuntimeHandle {
  return { id: sessionId, runtimeName: "tmux", data: {} };
}

export function getAttachCommand(
  runtimeHandle: RuntimeHandle | null | undefined,
  sessionId: string,
): string {
  const handle = runtimeHandle ?? defaultHandle(sessionId);
  switch (handle.runtimeName) {
    case "docker":
      return `docker attach ${handle.id}`;
    case "process":
      return "(no interactive attach available for process runtime)";
    case "tmux":
    default:
      return `tmux attach -t ${handle.id}`;
  }
}

export async function attachToRuntime(
  runtimeHandle: RuntimeHandle | null | undefined,
  sessionId: string,
): Promise<void> {
  const handle = runtimeHandle ?? defaultHandle(sessionId);

  const { cmd, args } =
    handle.runtimeName === "docker"
      ? { cmd: "docker", args: ["attach", handle.id] }
      : handle.runtimeName === "tmux"
        ? { cmd: "tmux", args: ["attach", "-t", handle.id] }
        : { cmd: "", args: [] as string[] };

  if (!cmd) {
    throw new Error(`Runtime "${handle.runtimeName}" does not support interactive attach`);
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.once("error", (err) => reject(err));
    child.once("exit", (code) => {
      if (code === 0 || code === null) {
        resolve();
        return;
      }
      reject(new Error(`${cmd} attach exited with code ${code}`));
    });
  });
}

export async function getLastActivityLabel(
  session: Pick<Session, "id" | "runtimeHandle" | "lastActivityAt">,
): Promise<string> {
  const runtimeHandle = session.runtimeHandle;
  if (!runtimeHandle || runtimeHandle.runtimeName === "tmux") {
    const target = runtimeHandle?.id ?? session.id;
    const activityTs = await getTmuxActivity(target);
    return activityTs ? formatAge(activityTs) : "-";
  }

  return session.lastActivityAt ? formatAge(session.lastActivityAt.getTime()) : "-";
}
