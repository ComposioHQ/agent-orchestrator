// agent-orchestrator: managed deveco activity plugin (do not edit)
//
// DevEco Code currently exposes the OpenCode plugin API and lifecycle events.
// This adapter intentionally installs in .deveco/plugins and dispatches to the
// independent `deveco` AO harness. The hook process is launched directly; no
// sh, bash, env command, or shell command string is involved on Windows.
import type { Plugin } from "@opencode-ai/plugin"

export const aoActivity: Plugin = async ({ directory, client }) => {
  const HOOK_TIMEOUT_MS = 30_000
  const promptReports = new Map<string, boolean>()
  const messageStore = new Map<string, any>()
  let currentSessionID: string | null = null
  let currentModel: string | null = null
  const launchID: string = (process.env.AO_RUNTIME_LAUNCH_ID ?? "").trim()

  function logHookFailure(hookName: string, detail: string) {
    try {
      void client?.app
        ?.log?.({ body: { service: "ao-activity", level: "error", message: `hook ${hookName} failed: ${detail}` } })
        ?.catch?.(() => {})
    } catch {
      // Logging must never affect the DevEco session.
    }
  }

  function callHookSync(hookName: string, payload: Record<string, unknown>) {
    try {
      const ao = Bun.which("ao")
      if (!ao) return
      const result = Bun.spawnSync([ao, "hooks", "deveco", hookName], {
        cwd: directory,
        env: { ...process.env, AO_RUNTIME_LAUNCH_ID: launchID },
        stdin: new TextEncoder().encode(JSON.stringify({ ...payload, launch_id: launchID }) + "\n"),
        stdout: "ignore",
        stderr: "pipe",
        timeout: HOOK_TIMEOUT_MS,
      })
      if (!result.success) {
        const stderr = result.stderr ? new TextDecoder().decode(result.stderr).trim() : ""
        logHookFailure(hookName, `exited ${result.exitCode}${stderr ? `: ${stderr}` : ""}`)
      }
    } catch (err) {
      logHookFailure(hookName, err instanceof Error ? err.message : String(err))
    }
  }

  function switchedSession(sessionID: string): boolean {
    if (currentSessionID === sessionID) return false
    promptReports.clear()
    messageStore.clear()
    currentModel = null
    currentSessionID = sessionID
    return true
  }

  function reportUserPrompt(sessionID: string, messageID: string, prompt: string) {
    const hasText = prompt.length > 0
    const reportedWithText = promptReports.get(messageID)
    if (reportedWithText) return
    if (reportedWithText === false && !hasText) return
    promptReports.set(messageID, hasText)
    callHookSync("user-prompt-submit", { session_id: sessionID, prompt, model: currentModel ?? "" })
  }

  return {
    event: async ({ event }) => {
      try {
        switch (event.type) {
          case "session.created": {
            const session = (event as any).properties?.info
            if (session?.id && switchedSession(session.id)) {
              callHookSync("session-start", { session_id: session.id })
            }
            break
          }
          case "message.updated": {
            const msg = (event as any).properties?.info
            if (!msg) break
            if (msg.sessionID && switchedSession(msg.sessionID)) {
              callHookSync("session-start", { session_id: msg.sessionID })
            }
            if (msg.role === "assistant" && msg.modelID) currentModel = msg.modelID
            if (msg.role === "user") {
              messageStore.set(msg.id, msg)
              const sessionID = msg.sessionID ?? currentSessionID
              if (sessionID) reportUserPrompt(sessionID, msg.id, "")
            }
            break
          }
          case "message.part.updated": {
            const part = (event as any).properties?.part
            if (!part?.messageID) break
            const msg = messageStore.get(part.messageID)
            if (msg?.role === "user" && part.type === "text") {
              const sessionID = msg.sessionID ?? currentSessionID
              const prompt = part.text ?? ""
              if (sessionID) reportUserPrompt(sessionID, msg.id, prompt)
              if (prompt.length > 0) messageStore.delete(part.messageID)
            }
            break
          }
          case "session.status": {
            const props = (event as any).properties
            if (props?.status?.type !== "idle") break
            const sessionID = props?.sessionID ?? currentSessionID
            if (sessionID) callHookSync("stop", { session_id: sessionID, model: currentModel ?? "" })
            break
          }
          case "permission.asked":
          case "question.asked": {
            const sessionID = (event as any).properties?.sessionID ?? currentSessionID
            if (sessionID) callHookSync("permission-blocked", { session_id: sessionID, model: currentModel ?? "" })
            break
          }
          case "permission.replied":
          case "question.replied":
          case "question.rejected": {
            const sessionID = (event as any).properties?.sessionID ?? currentSessionID
            if (sessionID) callHookSync("active", { session_id: sessionID, model: currentModel ?? "" })
            break
          }
        }
      } catch (err) {
        logHookFailure(`event:${(event as any)?.type ?? "unknown"}`, err instanceof Error ? err.message : String(err))
      }
    },
    "tool.execute.before": async (input) => {
      callHookSync("active", { session_id: input.sessionID, model: currentModel ?? "" })
    },
    "tool.execute.after": async (input) => {
      callHookSync("active", { session_id: input.sessionID, model: currentModel ?? "" })
    },
  }
}
