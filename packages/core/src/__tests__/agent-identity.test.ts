import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  computeFingerprint,
  generateAgentIdentity,
  signClaim,
  verifyClaim,
  computeTrustScore,
  saveAgentIdentityKey,
  loadAgentIdentityKey,
  loadAgentIdentity,
  type AgentIdentityWithKey,
  type TrustOutcome,
} from "../agent-identity.js";

let identitiesDir: string;

beforeEach(() => {
  identitiesDir = join(tmpdir(), `ao-test-identity-${randomUUID()}`);
  mkdirSync(identitiesDir, { recursive: true });
});

afterEach(() => {
  rmSync(identitiesDir, { recursive: true, force: true });
});

// =============================================================================
// computeFingerprint
// =============================================================================

describe("computeFingerprint", () => {
  it("returns a 64-char hex string (SHA-256)", () => {
    const fingerprint = computeFingerprint("some public key pem content");
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same input", () => {
    const pem = "-----BEGIN PUBLIC KEY-----\nfakepemdata\n-----END PUBLIC KEY-----\n";
    expect(computeFingerprint(pem)).toBe(computeFingerprint(pem));
  });

  it("produces different fingerprints for different keys", () => {
    const a = computeFingerprint("key-a");
    const b = computeFingerprint("key-b");
    expect(a).not.toBe(b);
  });
});

// =============================================================================
// generateAgentIdentity
// =============================================================================

describe("generateAgentIdentity", () => {
  it("generates an identity with expected fields", () => {
    const identity = generateAgentIdentity("app-1", "my-project", null);

    expect(identity.sessionId).toBe("app-1");
    expect(identity.projectId).toBe("my-project");
    expect(identity.spawnedBy).toBeNull();
    expect(identity.agentId).toMatch(/^did:ao:app-1:/);
    expect(identity.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(identity.publicKey).toContain("BEGIN PUBLIC KEY");
    expect(identity.privateKey).toContain("BEGIN PRIVATE KEY");
    expect(identity.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("embeds a 16-char prefix of the fingerprint in agentId", () => {
    const identity = generateAgentIdentity("app-2", "proj");
    const idParts = identity.agentId.split(":");
    expect(idParts).toHaveLength(4); // did, ao, sessionId, fingerprint-prefix
    expect(identity.fingerprint.startsWith(idParts[3])).toBe(true);
    expect(idParts[3]).toHaveLength(16);
  });

  it("records spawnedBy when provided", () => {
    const identity = generateAgentIdentity("worker-1", "proj", "orchestrator-1");
    expect(identity.spawnedBy).toBe("orchestrator-1");
  });

  it("generates unique key pairs for different sessions", () => {
    const a = generateAgentIdentity("sess-a", "proj");
    const b = generateAgentIdentity("sess-b", "proj");
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.fingerprint).not.toBe(b.fingerprint);
    expect(a.agentId).not.toBe(b.agentId);
  });

  it("fingerprint matches computeFingerprint of the public key", () => {
    const identity = generateAgentIdentity("app-3", "proj");
    expect(identity.fingerprint).toBe(computeFingerprint(identity.publicKey));
  });
});

// =============================================================================
// signClaim / verifyClaim
// =============================================================================

describe("signClaim / verifyClaim", () => {
  let identity: AgentIdentityWithKey;

  beforeEach(() => {
    identity = generateAgentIdentity("signer-1", "test-project");
  });

  it("signs and verifies a simple payload", () => {
    const claim = signClaim(identity.agentId, { action: "task_done", issueId: "INT-42" }, identity.privateKey);

    expect(claim.agentId).toBe(identity.agentId);
    expect(claim.payload).toEqual({ action: "task_done", issueId: "INT-42" });
    expect(claim.signature).toBeTruthy();
    expect(typeof claim.signedAt).toBe("string");

    expect(verifyClaim(claim, identity.publicKey)).toBe(true);
  });

  it("returns false when the signature is tampered with", () => {
    const claim = signClaim(identity.agentId, { status: "ok" }, identity.privateKey);
    const tampered = { ...claim, signature: "invalidsignaturedata" };
    expect(verifyClaim(tampered, identity.publicKey)).toBe(false);
  });

  it("returns false when the payload is modified after signing", () => {
    const claim = signClaim(identity.agentId, { value: 1 }, identity.privateKey);
    const tampered = { ...claim, payload: { value: 2 } };
    expect(verifyClaim(tampered, identity.publicKey)).toBe(false);
  });

  it("returns false when verified with a different public key", () => {
    const other = generateAgentIdentity("other-1", "proj");
    const claim = signClaim(identity.agentId, { ping: true }, identity.privateKey);
    expect(verifyClaim(claim, other.publicKey)).toBe(false);
  });

  it("handles null and array payloads", () => {
    const nullClaim = signClaim(identity.agentId, null, identity.privateKey);
    expect(verifyClaim(nullClaim, identity.publicKey)).toBe(true);

    const arrClaim = signClaim(identity.agentId, [1, 2, 3], identity.privateKey);
    expect(verifyClaim(arrClaim, identity.publicKey)).toBe(true);
  });

  it("returns false for a completely invalid claim object", () => {
    const invalid = { agentId: "x", payload: {}, signedAt: "bad", signature: "!!!" };
    expect(verifyClaim(invalid, identity.publicKey)).toBe(false);
  });
});

// =============================================================================
// computeTrustScore
// =============================================================================

describe("computeTrustScore", () => {
  it("returns 0.5 neutral score for empty history", () => {
    const score = computeTrustScore([]);
    expect(score.score).toBe(0.5);
    expect(score.sampleCount).toBe(0);
    expect(score.outcomes).toEqual({});
  });

  it("perfect positive history scores above 0.5", () => {
    const outcomes: TrustOutcome[] = ["pr_merged", "pr_merged", "approved", "ci_passed"];
    const score = computeTrustScore(outcomes);
    expect(score.score).toBeGreaterThan(0.5);
    expect(score.sampleCount).toBe(4);
  });

  it("all failures scores below 0.5", () => {
    const outcomes: TrustOutcome[] = ["errored", "errored", "ci_failed", "stuck"];
    const score = computeTrustScore(outcomes);
    expect(score.score).toBeLessThan(0.5);
  });

  it("score is clamped to [0, 1]", () => {
    const allBad: TrustOutcome[] = Array(20).fill("errored") as TrustOutcome[];
    const allGood: TrustOutcome[] = Array(20).fill("pr_merged") as TrustOutcome[];

    expect(computeTrustScore(allBad).score).toBeGreaterThanOrEqual(0);
    expect(computeTrustScore(allBad).score).toBeLessThanOrEqual(1);
    expect(computeTrustScore(allGood).score).toBeGreaterThanOrEqual(0);
    expect(computeTrustScore(allGood).score).toBeLessThanOrEqual(1);
  });

  it("counts outcomes correctly", () => {
    const outcomes: TrustOutcome[] = ["pr_merged", "ci_failed", "pr_merged", "ci_failed", "ci_failed"];
    const score = computeTrustScore(outcomes);
    expect(score.outcomes["pr_merged"]).toBe(2);
    expect(score.outcomes["ci_failed"]).toBe(3);
    expect(score.outcomes["errored"]).toBeUndefined();
  });

  it("mixed outcomes produce a middle range score", () => {
    const outcomes: TrustOutcome[] = ["pr_merged", "errored", "ci_passed", "ci_failed"];
    const score = computeTrustScore(outcomes);
    expect(score.score).toBeGreaterThan(0);
    expect(score.score).toBeLessThan(1);
  });
});

// =============================================================================
// saveAgentIdentityKey / loadAgentIdentityKey / loadAgentIdentity
// =============================================================================

describe("saveAgentIdentityKey / loadAgentIdentityKey", () => {
  it("saves and loads a full identity", () => {
    const original = generateAgentIdentity("app-10", "project-x", "orch-1");
    saveAgentIdentityKey(identitiesDir, original);

    const loaded = loadAgentIdentityKey(identitiesDir, "app-10");
    expect(loaded).not.toBeNull();
    expect(loaded!.agentId).toBe(original.agentId);
    expect(loaded!.sessionId).toBe(original.sessionId);
    expect(loaded!.projectId).toBe(original.projectId);
    expect(loaded!.fingerprint).toBe(original.fingerprint);
    expect(loaded!.publicKey).toBe(original.publicKey);
    expect(loaded!.privateKey).toBe(original.privateKey);
    expect(loaded!.createdAt).toBe(original.createdAt);
    expect(loaded!.spawnedBy).toBe("orch-1");
  });

  it("creates the identities directory if it does not exist", () => {
    const nested = join(identitiesDir, "new-subdir");
    const identity = generateAgentIdentity("app-11", "proj");
    saveAgentIdentityKey(nested, identity);
    expect(existsSync(nested)).toBe(true);
  });

  it("returns null for a non-existent session", () => {
    expect(loadAgentIdentityKey(identitiesDir, "missing-99")).toBeNull();
  });

  it("persists with mode 0600 (owner read/write only)", () => {
    const identity = generateAgentIdentity("app-12", "proj");
    saveAgentIdentityKey(identitiesDir, identity);
    const filePath = join(identitiesDir, "app-12.identity.json");
    const stat = statSync(filePath);
    // On POSIX, mode & 0o777 should be 0o600
    // On Windows this check is skipped (file permissions work differently)
    if (process.platform !== "win32") {
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it("the identity file is valid JSON", () => {
    const identity = generateAgentIdentity("app-13", "proj");
    saveAgentIdentityKey(identitiesDir, identity);
    const filePath = join(identitiesDir, "app-13.identity.json");
    expect(() => JSON.parse(readFileSync(filePath, "utf-8"))).not.toThrow();
  });
});

describe("loadAgentIdentity (public only)", () => {
  it("loads public identity without privateKey", () => {
    const original = generateAgentIdentity("pub-1", "proj");
    saveAgentIdentityKey(identitiesDir, original);

    const pub = loadAgentIdentity(identitiesDir, "pub-1");
    expect(pub).not.toBeNull();
    expect(pub!.agentId).toBe(original.agentId);
    expect(pub!.fingerprint).toBe(original.fingerprint);
    expect(pub!.publicKey).toBe(original.publicKey);
    // privateKey must not be present
    expect("privateKey" in pub!).toBe(false);
  });

  it("returns null when no identity exists", () => {
    expect(loadAgentIdentity(identitiesDir, "no-such-session")).toBeNull();
  });
});

// =============================================================================
// End-to-end: generate → save → load → sign → verify
// =============================================================================

describe("end-to-end identity workflow", () => {
  it("an agent can sign a claim that another party verifies using only the public identity", () => {
    // Agent generates its identity and stores the key pair
    const agentIdentity = generateAgentIdentity("e2e-agent-1", "my-project", "orchestrator-1");
    saveAgentIdentityKey(identitiesDir, agentIdentity);

    // Agent signs a claim
    const claim = signClaim(
      agentIdentity.agentId,
      { taskId: "TASK-123", outcome: "pr_merged" },
      agentIdentity.privateKey,
    );

    // Verifier loads only the public identity (no private key needed)
    const publicIdentity = loadAgentIdentity(identitiesDir, "e2e-agent-1");
    expect(publicIdentity).not.toBeNull();

    // Verifier checks the claim is authentic
    expect(verifyClaim(claim, publicIdentity!.publicKey)).toBe(true);

    // The fingerprint stored in metadata matches the loaded public key
    expect(publicIdentity!.fingerprint).toBe(computeFingerprint(publicIdentity!.publicKey));
  });
});
