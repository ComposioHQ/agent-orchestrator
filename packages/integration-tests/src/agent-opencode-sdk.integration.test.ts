import { describe, expect, it } from "vitest";
import { isTmuxAvailable } from "./helpers/tmux.js";
import { isOpencodeAvailable, listOpencodeModels, pickCheapModel } from "./helpers/opencode.js";

const tmuxOk = await isTmuxAvailable();
const opencodeOk = await isOpencodeAvailable();

describe.skipIf(!(tmuxOk && opencodeOk))("agent-opencode-sdk parity (integration)", () => {
  it("T00: discovers cheap live model candidate", async () => {
    const models = await listOpencodeModels();
    expect(models.length).toBeGreaterThan(0);

    const model = await pickCheapModel();
    expect(model).toBeTruthy();
    expect(models).toContain(model as string);
  });

  it.todo("T01: SDK bootstrap through sessionManager.spawn");
  it.todo("T02: server metadata and /global/health assertion");
  it.todo("T03: OpenCode session continuity via export/session.get");
  it.todo("T04: send() routes via SDK and appends assistant turn");
  it.todo("T05: activity state is non-null and session-specific");
  it.todo("T06: session info isolation across two sessions same workspace");
  it.todo("T07: restore keeps same OpenCode session timeline");
  it.todo("T08: kill aborts/deletes OpenCode session and server pid");
  it.todo("T09: web terminal attach mode uses opencode -s --attach");
  it.todo("T10: non-opencode terminal path remains tmux attach");
  it.todo("T11: /api/sessions/[id]/message delegates via session-manager");
  it.todo("T12: full lifecycle smoke with metadata invariants");
});
