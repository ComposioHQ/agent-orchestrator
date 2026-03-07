import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentBus, createLearningEntry } from "../agent-bus.js";

describe("AgentBus", () => {
  let tempDir: string;
  let bus: AgentBus;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ao-bus-test-"));
    const agentsDir = join(tempDir, ".agents");
    bus = new AgentBus({ agentsDir });
    bus.init();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("init", () => {
    it("creates directory structure", () => {
      expect(existsSync(join(tempDir, ".agents", "status"))).toBe(true);
      expect(existsSync(join(tempDir, ".agents", "locks"))).toBe(true);
      expect(existsSync(join(tempDir, ".agents", "artifacts"))).toBe(true);
      expect(existsSync(join(tempDir, ".agents", "bin"))).toBe(true);
    });
  });

  describe("status", () => {
    it("writes and reads agent status", () => {
      const status = bus.initAgentStatus("driver", "driver", "implement");
      expect(status.name).toBe("driver");
      expect(status.role).toBe("driver");
      expect(status.phase).toBe("implement");
      expect(status.state).toBe("idle");

      const read = bus.readStatus("driver");
      expect(read).not.toBeNull();
      expect(read!.name).toBe("driver");
    });

    it("updates agent state to done", () => {
      bus.initAgentStatus("driver", "driver", "implement");
      const updated = bus.setDone("driver");
      expect(updated!.state).toBe("done");
    });

    it("updates agent state to working with file", () => {
      bus.initAgentStatus("driver", "driver", "implement");
      const updated = bus.setWorking("driver", "src/auth.ts");
      expect(updated!.state).toBe("working");
      expect(updated!.currentFile).toBe("src/auth.ts");
    });

    it("reads all statuses", () => {
      bus.initAgentStatus("planner", "planner", "plan");
      bus.initAgentStatus("driver", "driver", "implement");
      const all = bus.readAllStatuses();
      expect(all).toHaveLength(2);
    });

    it("returns null for unknown agent", () => {
      expect(bus.readStatus("unknown")).toBeNull();
    });
  });

  describe("messages", () => {
    it("sends and reads messages", () => {
      bus.sendMessage("engine", "planner", "plan", "Start planning");
      const messages = bus.readMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0].from).toBe("engine");
      expect(messages[0].to).toBe("planner");
      expect(messages[0].content).toBe("Start planning");
      expect(messages[0].seq).toBe(1);
    });

    it("auto-increments sequence numbers", () => {
      bus.sendMessage("engine", "planner", "plan", "msg 1");
      bus.sendMessage("planner", "driver", "plan", "msg 2");
      const messages = bus.readMessages();
      expect(messages[0].seq).toBe(1);
      expect(messages[1].seq).toBe(2);
    });

    it("filters messages for agent", () => {
      bus.sendMessage("engine", "planner", "plan", "for planner");
      bus.sendMessage("engine", "driver", "plan", "for driver");
      bus.sendMessage("reviewer", "driver", "review", "review note");

      const driverMsgs = bus.readMessagesFor("driver");
      expect(driverMsgs).toHaveLength(2);

      const fromReviewer = bus.readMessagesFor("driver", { from: "reviewer" });
      expect(fromReviewer).toHaveLength(1);
    });

    it("supports since filter", () => {
      bus.sendMessage("a", "b", "plan", "msg 1");
      bus.sendMessage("a", "b", "plan", "msg 2");
      bus.sendMessage("a", "b", "plan", "msg 3");

      const since2 = bus.readMessagesFor("b", { since: 2 });
      expect(since2).toHaveLength(1);
      expect(since2[0].seq).toBe(3);
    });
  });

  describe("plan", () => {
    it("writes and reads plan", () => {
      const plan = {
        summary: "Test plan",
        workUnits: [
          {
            id: "wu-1",
            description: "Test unit",
            assignedTo: "driver",
            files: ["src/a.ts"],
            criteria: "It works",
          },
        ],
        sharedFiles: ["src/index.ts"],
        integrateOrder: ["driver"],
      };

      bus.writePlan(plan);
      const read = bus.readPlan();
      expect(read).not.toBeNull();
      expect(read!.summary).toBe("Test plan");
      expect(read!.workUnits).toHaveLength(1);
    });

    it("returns null when no plan exists", () => {
      expect(bus.readPlan()).toBeNull();
    });
  });

  describe("control", () => {
    it("writes and reads control signals", () => {
      bus.writeControl({ signal: "shutdown", ts: new Date().toISOString(), reason: "test" });
      const control = bus.readControl();
      expect(control).not.toBeNull();
      expect(control!.signal).toBe("shutdown");
    });
  });

  describe("artifacts", () => {
    it("writes and reads artifacts", () => {
      bus.writeArtifact("test.md", "# Test Report\n\nAll good.");
      const content = bus.readArtifact("test.md");
      expect(content).toBe("# Test Report\n\nAll good.");
    });

    it("returns null for missing artifact", () => {
      expect(bus.readArtifact("missing.md")).toBeNull();
    });

    it("lists artifacts", () => {
      bus.writeArtifact("a.md", "content");
      bus.writeArtifact("b.json", "{}");
      const list = bus.listArtifacts();
      expect(list).toContain("a.md");
      expect(list).toContain("b.json");
    });
  });

  describe("learnings buffer", () => {
    it("buffers learning entries", () => {
      const entry = createLearningEntry("convention", "Use barrel exports", "driver", "implement");
      bus.bufferLearning(entry);

      const buffer = bus.readLearningsBuffer();
      expect(buffer).toHaveLength(1);
      expect(buffer[0].category).toBe("convention");
      expect(buffer[0].description).toBe("Use barrel exports");
    });
  });

  describe("locks", () => {
    it("acquires and releases locks", () => {
      const acquired = bus.acquireLock("src/auth.ts");
      expect(acquired).toBe(true);

      // Second acquire should fail
      const second = bus.acquireLock("src/auth.ts");
      expect(second).toBe(false);

      // Release and re-acquire
      bus.releaseLock("src/auth.ts");
      const third = bus.acquireLock("src/auth.ts");
      expect(third).toBe(true);
    });

    it("encodes paths correctly", () => {
      const encoded = bus.encodeLockPath("src/middleware/auth.ts");
      expect(encoded).toBe("src--middleware--auth.ts.lock");
    });
  });
});
