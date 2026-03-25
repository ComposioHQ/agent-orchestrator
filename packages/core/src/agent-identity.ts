/**
 * Agent Identity — Cryptographic identity for orchestrated sub-agents.
 *
 * Each agent session spawned by the orchestrator receives an Ed25519 key pair.
 * The public key fingerprint is stored in session metadata for audit trails.
 * The private key is persisted in a separate identities directory so agents
 * can sign claims that other parties can independently verify.
 *
 * Identity format:
 *   agentId: "did:ao:{sessionId}:{fingerprint}"
 *   fingerprint: hex-encoded SHA-256 of the DER-encoded public key
 *
 * Trust scoring:
 *   Computed from session outcomes (merged PRs, successful CI, etc.) and
 *   used to rank agents for task assignment in parallel orchestration.
 */

import {
  createHash,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { SessionId } from "./types.js";

// =============================================================================
// TYPES
// =============================================================================

/** Cryptographic identity assigned to an agent session. */
export interface AgentIdentity {
  /** DID-like identifier: "did:ao:{sessionId}:{fingerprint}" */
  agentId: string;

  /** The session this identity belongs to */
  sessionId: SessionId;

  /** The project this session belongs to */
  projectId: string;

  /**
   * Hex-encoded SHA-256 fingerprint of the DER-encoded public key.
   * Stored in session metadata for verification without the full key.
   */
  fingerprint: string;

  /** PEM-encoded Ed25519 public key */
  publicKey: string;

  /** ISO timestamp when this identity was created */
  createdAt: string;

  /**
   * Session ID of the orchestrator or parent that spawned this agent.
   * Null for top-level orchestrator sessions.
   */
  spawnedBy: SessionId | null;
}

/** Full identity including private key — never persisted to metadata. */
export interface AgentIdentityWithKey extends AgentIdentity {
  /** PEM-encoded Ed25519 private key — keep secret, store in identities dir only */
  privateKey: string;
}

/** A signed claim produced by an agent. */
export interface AgentClaim {
  /** The agent identity that signed this claim */
  agentId: string;

  /** The claim payload as a JSON-serialisable value */
  payload: unknown;

  /** ISO timestamp when the claim was signed */
  signedAt: string;

  /** Base64-encoded Ed25519 signature over `agentId + signedAt + JSON(payload)` */
  signature: string;
}

/** Possible outcomes used to calculate trust score. */
export type TrustOutcome =
  | "pr_merged" // Session's PR was merged — strong positive signal
  | "ci_passed" // CI passed without failures — positive signal
  | "ci_failed" // CI failed — mild negative signal
  | "changes_requested" // PR required changes — mild negative signal
  | "approved" // PR approved without changes — positive signal
  | "stuck" // Session became stuck / needed input — mild negative signal
  | "errored"; // Session errored out — strong negative signal

/** Trust score for an agent, computed from historical outcomes. */
export interface TrustScore {
  /** Normalised score in [0, 1]; higher is better */
  score: number;

  /** Number of outcomes considered */
  sampleCount: number;

  /** Breakdown of outcome counts */
  outcomes: Partial<Record<TrustOutcome, number>>;
}

// =============================================================================
// IDENTITY GENERATION
// =============================================================================

/**
 * Compute a hex-encoded SHA-256 fingerprint from a PEM-encoded public key.
 */
export function computeFingerprint(publicKeyPem: string): string {
  return createHash("sha256").update(publicKeyPem).digest("hex");
}

/**
 * Generate a new Ed25519 cryptographic identity for an agent session.
 *
 * Returns the full identity including the private key. Callers are
 * responsible for persisting the private key via `saveAgentIdentityKey`.
 */
export function generateAgentIdentity(
  sessionId: SessionId,
  projectId: string,
  spawnedBy: SessionId | null = null,
): AgentIdentityWithKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  const fingerprint = computeFingerprint(publicKey);
  const agentId = `did:ao:${sessionId}:${fingerprint.slice(0, 16)}`;
  const createdAt = new Date().toISOString();

  return {
    agentId,
    sessionId,
    projectId,
    fingerprint,
    publicKey,
    privateKey,
    createdAt,
    spawnedBy,
  };
}

// =============================================================================
// CLAIM SIGNING & VERIFICATION
// =============================================================================

/**
 * Build the canonical string that is signed/verified for a claim.
 * Format: `{agentId}\n{signedAt}\n{JSON(payload)}`
 */
function buildSigningInput(agentId: string, signedAt: string, payload: unknown): string {
  return `${agentId}\n${signedAt}\n${JSON.stringify(payload)}`;
}

/**
 * Sign a claim payload with the agent's Ed25519 private key.
 *
 * @param agentId - The agent's DID identifier
 * @param payload - Any JSON-serialisable value to sign
 * @param privateKeyPem - PEM-encoded Ed25519 private key
 * @returns A signed `AgentClaim`
 */
export function signClaim(
  agentId: string,
  payload: unknown,
  privateKeyPem: string,
): AgentClaim {
  const signedAt = new Date().toISOString();
  const input = buildSigningInput(agentId, signedAt, payload);

  // Ed25519 uses null as the algorithm — the hash is internal to the key scheme.
  const signature = cryptoSign(null, Buffer.from(input), privateKeyPem).toString("base64");

  return { agentId, payload, signedAt, signature };
}

/**
 * Verify a signed claim against the agent's public key.
 *
 * @returns `true` if the signature is valid, `false` otherwise
 */
export function verifyClaim(claim: AgentClaim, publicKeyPem: string): boolean {
  try {
    const input = buildSigningInput(claim.agentId, claim.signedAt, claim.payload);
    return cryptoVerify(
      null,
      Buffer.from(input),
      publicKeyPem,
      Buffer.from(claim.signature, "base64"),
    );
  } catch {
    return false;
  }
}

// =============================================================================
// TRUST SCORING
// =============================================================================

/** Weight assigned to each outcome type (positive = trust boost). */
const OUTCOME_WEIGHTS: Record<TrustOutcome, number> = {
  pr_merged: 1.0,
  approved: 0.6,
  ci_passed: 0.4,
  ci_failed: -0.3,
  changes_requested: -0.2,
  stuck: -0.15,
  errored: -0.6,
};

/**
 * Compute a trust score from a list of historical session outcomes.
 *
 * The score is normalised to [0, 1] where 0.5 is neutral (no history).
 * Each outcome shifts the score by its weight divided by the sample count
 * to prevent gaming with large numbers of minor events.
 */
export function computeTrustScore(outcomes: TrustOutcome[]): TrustScore {
  if (outcomes.length === 0) {
    return { score: 0.5, sampleCount: 0, outcomes: {} };
  }

  const counts: Partial<Record<TrustOutcome, number>> = {};
  let weightedSum = 0;

  for (const outcome of outcomes) {
    counts[outcome] = (counts[outcome] ?? 0) + 1;
    weightedSum += OUTCOME_WEIGHTS[outcome];
  }

  // Normalise: start at 0.5, add average weight scaled to [−0.5, +0.5]
  const avgWeight = weightedSum / outcomes.length;
  const maxAbsWeight = Math.max(...Object.values(OUTCOME_WEIGHTS).map(Math.abs));
  const score = Math.min(1, Math.max(0, 0.5 + avgWeight / (2 * maxAbsWeight)));

  return { score, sampleCount: outcomes.length, outcomes: counts };
}

// =============================================================================
// PERSISTENCE
// =============================================================================

/** File name for the identity key store within the identities directory. */
function identityKeyPath(identitiesDir: string, sessionId: SessionId): string {
  return join(identitiesDir, `${sessionId}.identity.json`);
}

/**
 * Persist an agent's full identity (including private key) to the identities
 * directory. The file is readable only by the current user (mode 0600).
 */
export function saveAgentIdentityKey(
  identitiesDir: string,
  identity: AgentIdentityWithKey,
): void {
  mkdirSync(identitiesDir, { recursive: true });
  const path = identityKeyPath(identitiesDir, identity.sessionId);
  const content = JSON.stringify(
    {
      agentId: identity.agentId,
      sessionId: identity.sessionId,
      projectId: identity.projectId,
      fingerprint: identity.fingerprint,
      publicKey: identity.publicKey,
      privateKey: identity.privateKey,
      createdAt: identity.createdAt,
      spawnedBy: identity.spawnedBy,
    },
    null,
    2,
  );
  writeFileSync(path, content, { mode: 0o600 });
}

/**
 * Load a persisted agent identity (including private key) from disk.
 * Returns `null` if no identity exists for the given session.
 */
export function loadAgentIdentityKey(
  identitiesDir: string,
  sessionId: SessionId,
): AgentIdentityWithKey | null {
  const path = identityKeyPath(identitiesDir, sessionId);
  if (!existsSync(path)) return null;

  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (!raw || typeof raw !== "object") return null;

    const r = raw as Record<string, unknown>;
    if (
      typeof r["agentId"] !== "string" ||
      typeof r["sessionId"] !== "string" ||
      typeof r["projectId"] !== "string" ||
      typeof r["fingerprint"] !== "string" ||
      typeof r["publicKey"] !== "string" ||
      typeof r["privateKey"] !== "string" ||
      typeof r["createdAt"] !== "string"
    ) {
      return null;
    }

    return {
      agentId: r["agentId"],
      sessionId: r["sessionId"],
      projectId: r["projectId"],
      fingerprint: r["fingerprint"],
      publicKey: r["publicKey"],
      privateKey: r["privateKey"],
      createdAt: r["createdAt"],
      spawnedBy: typeof r["spawnedBy"] === "string" ? r["spawnedBy"] : null,
    };
  } catch {
    return null;
  }
}

/**
 * Load only the public identity (no private key) from a persisted identity
 * file. Useful for verification without needing the private key.
 */
export function loadAgentIdentity(
  identitiesDir: string,
  sessionId: SessionId,
): AgentIdentity | null {
  const full = loadAgentIdentityKey(identitiesDir, sessionId);
  if (!full) return null;

  const { privateKey: _privateKey, ...publicIdentity } = full;
  return publicIdentity;
}
