import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  validateDoneEvidence,
  computeEvidenceHash,
  extractAttestationFromCommentBody,
  verifyAttestation,
  type AttestationPayload,
} from "../lib/done-evidence.js";

describe("validateDoneEvidence", () => {
  it("case 1: evidence undefined + dry-run → ok=true with missing evidence reason", () => {
    const result = validateDoneEvidence(undefined, { issueId: "issue-1" });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("dry-run");
    expect(result.reasons).toContain("missing evidence object");
  });

  it("case 2: bad commit_sha + dry-run → ok=true, reasons contains 'commit_sha'", () => {
    const result = validateDoneEvidence(
      { commit_sha: "not-a-sha!" },
      { issueId: "issue-2" },
    );
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("dry-run");
    expect(result.reasons.some((r) => r.includes("commit_sha"))).toBe(true);
  });

  describe("enforce mode", () => {
    const originalEnv = process.env.DONE_EVIDENCE_MODE;

    beforeEach(() => {
      process.env.DONE_EVIDENCE_MODE = "enforce";
    });

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env.DONE_EVIDENCE_MODE;
      } else {
        process.env.DONE_EVIDENCE_MODE = originalEnv;
      }
    });

    it("case 3: bad commit_sha + enforce → ok=false", () => {
      const result = validateDoneEvidence(
        { commit_sha: "not-a-sha!" },
        { issueId: "issue-3" },
      );
      expect(result.ok).toBe(false);
      expect(result.mode).toBe("enforce");
    });

    it("case 4: non-existent output_files + enforce → ok=false with 'output_file not found'", () => {
      const result = validateDoneEvidence(
        { output_files: ["/this/path/does/not/exist/ever.txt"] },
        { issueId: "issue-4" },
      );
      expect(result.ok).toBe(false);
      expect(result.reasons.some((r) => r.includes("output_file not found"))).toBe(true);
    });

    it("case 5: valid evidence with existing file + enforce → ok=true, reasons=[]", () => {
      const result = validateDoneEvidence(
        {
          commit_sha: "abc1234",
          output_files: [__filename],
        },
        { issueId: "issue-5" },
      );
      expect(result.ok).toBe(true);
      expect(result.reasons).toHaveLength(0);
    });

    it("case 6: {} empty evidence + enforce → ok=false, reasons contains 'at least one of'", () => {
      const result = validateDoneEvidence({}, { issueId: "issue-6" });
      expect(result.ok).toBe(false);
      expect(result.mode).toBe("enforce");
      expect(result.reasons.some((r) => r.includes("at least one of"))).toBe(true);
    });
  });
});

describe("extractAttestationFromCommentBody", () => {
  it("case 7: fenced ```json``` block with valid attestation → parsed correctly", () => {
    const payload: AttestationPayload = {
      schema_version: "1.0",
      verdict: "GO",
      issue_id: "issue-abc",
      commit_sha: "abc1234def",
      evidence_hash: "deadbeef",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    };
    const body = `Some text before\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`\nSome text after`;
    const result = extractAttestationFromCommentBody(body);
    expect(result).not.toBeNull();
    expect(result?.verdict).toBe("GO");
    expect(result?.issue_id).toBe("issue-abc");
  });

  it("case 8: verdict not GO/NO-GO → null", () => {
    const body = `\`\`\`json\n${JSON.stringify({
      schema_version: "1.0",
      verdict: "MAYBE",
      issue_id: "issue-abc",
      commit_sha: "abc1234def",
      evidence_hash: "deadbeef",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    })}\n\`\`\``;
    const result = extractAttestationFromCommentBody(body);
    expect(result).toBeNull();
  });
});

describe("verifyAttestation", () => {
  const makeValidAttestation = (overrides: Partial<AttestationPayload> = {}): AttestationPayload => ({
    schema_version: "1.0",
    verdict: "GO",
    issue_id: "issue-123",
    commit_sha: "abc1234",
    evidence_hash: "somehash",
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    ...overrides,
  });

  const makeComment = (authorAgentId: string | null, attestation: AttestationPayload) => ({
    id: "comment-1",
    authorAgentId,
    body: `\`\`\`json\n${JSON.stringify(attestation)}\n\`\`\``,
  });

  it("case 9: expectedVerifierAgentId undefined → ok=false", async () => {
    const result = await verifyAttestation("comment-1", {
      expectedVerifierAgentId: undefined,
      expectedIssueId: "issue-123",
      fetchComment: async () => makeComment("agent-v", makeValidAttestation()),
    });
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes("VERIFIER_AGENT_ID"))).toBe(true);
  });

  it("case 10: comment authorAgentId != verifier → ok=false", async () => {
    const result = await verifyAttestation("comment-1", {
      expectedVerifierAgentId: "agent-verifier",
      expectedIssueId: "issue-123",
      fetchComment: async () => makeComment("agent-impostor", makeValidAttestation()),
    });
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes("not the verifier agent"))).toBe(true);
  });

  it("case 11: issue_id mismatch → ok=false", async () => {
    const attestation = makeValidAttestation({ issue_id: "issue-WRONG" });
    const result = await verifyAttestation("comment-1", {
      expectedVerifierAgentId: "agent-verifier",
      expectedIssueId: "issue-123",
      fetchComment: async () => makeComment("agent-verifier", attestation),
    });
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes("issue_id mismatch"))).toBe(true);
  });

  it("case 12: expired attestation → ok=false", async () => {
    const pastExpiry = new Date(Date.now() - 1_000).toISOString();
    const attestation = makeValidAttestation({ expires_at: pastExpiry });
    const result = await verifyAttestation("comment-1", {
      expectedVerifierAgentId: "agent-verifier",
      expectedIssueId: "issue-123",
      fetchComment: async () => makeComment("agent-verifier", attestation),
      now: () => new Date(), // current time is after expiry
    });
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes("expired"))).toBe(true);
  });

  it("case 13: GO + all fields match + not expired → ok=true", async () => {
    const attestation = makeValidAttestation({
      issue_id: "issue-123",
      commit_sha: "abc1234",
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const result = await verifyAttestation("comment-1", {
      expectedVerifierAgentId: "agent-verifier",
      expectedIssueId: "issue-123",
      expectedCommitSha: "abc1234",
      fetchComment: async () => makeComment("agent-verifier", attestation),
      now: () => new Date(Date.now() - 1_000), // now is before expiry
    });
    expect(result.ok).toBe(true);
    expect(result.reasons).toHaveLength(0);
    expect(result.attestation?.verdict).toBe("GO");
  });
});

describe("verifyAttestation — P0/P1 additions", () => {
  const makeValidAttestation = (overrides: Partial<AttestationPayload> = {}): AttestationPayload => ({
    schema_version: "1.0",
    verdict: "GO",
    issue_id: "issue-123",
    commit_sha: "abc1234",
    evidence_hash: "somehash",
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    ...overrides,
  });

  const makeComment = (authorAgentId: string | null, attestation: AttestationPayload) => ({
    id: "comment-1",
    authorAgentId,
    body: `\`\`\`json\n${JSON.stringify(attestation)}\n\`\`\``,
  });

  it("case 15: enforce + no attestation_id → logical rejection (unit: verifyAttestation with no VERIFIER_AGENT_ID → ok=false)", async () => {
    // Routes enforce-without-attestation rejection is in issues.ts (HTTP 422).
    // Here we confirm verifyAttestation with undefined expectedVerifierAgentId → ok=false (existing case 9 shape).
    const result = await verifyAttestation("comment-1", {
      expectedVerifierAgentId: undefined,
      expectedIssueId: "issue-123",
      fetchComment: async () => makeComment("agent-v", makeValidAttestation()),
    });
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes("VERIFIER_AGENT_ID"))).toBe(true);
  });

  it("case 16: actualEvidence hash mismatch → ok=false, reasons contains 'evidence_hash mismatch'", async () => {
    const correctHash = computeEvidenceHash({ commit_sha: "abc1234" });
    const attestation = makeValidAttestation({ evidence_hash: correctHash });
    const result = await verifyAttestation("comment-1", {
      expectedVerifierAgentId: "agent-verifier",
      expectedIssueId: "issue-123",
      actualEvidence: { commit_sha: "different-sha" }, // produces different hash
      fetchComment: async () => makeComment("agent-verifier", attestation),
    });
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes("evidence_hash mismatch"))).toBe(true);
  });

  it("case 17: actualEvidence hash match → ok=true", async () => {
    const evidence = { commit_sha: "abc1234", verification_command: "pnpm test", verification_output: "ok" };
    const correctHash = computeEvidenceHash(evidence);
    const attestation = makeValidAttestation({ evidence_hash: correctHash });
    const result = await verifyAttestation("comment-1", {
      expectedVerifierAgentId: "agent-verifier",
      expectedIssueId: "issue-123",
      expectedCommitSha: "abc1234",
      actualEvidence: evidence,
      fetchComment: async () => makeComment("agent-verifier", attestation),
      now: () => new Date(Date.now() - 1_000),
    });
    expect(result.ok).toBe(true);
    expect(result.reasons).toHaveLength(0);
  });

  it("case 18: expires_at = 'invalid-date-string' → ok=false, reasons contains 'invalid or unparseable'", async () => {
    const attestation = makeValidAttestation({ expires_at: "invalid-date-string" });
    const result = await verifyAttestation("comment-1", {
      expectedVerifierAgentId: "agent-verifier",
      expectedIssueId: "issue-123",
      fetchComment: async () => makeComment("agent-verifier", attestation),
      now: () => new Date(),
    });
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes("invalid or unparseable"))).toBe(true);
  });
});

describe("extractAttestationFromCommentBody — P1-4 exactly-one", () => {
  const makeValidPayload = (): AttestationPayload => ({
    schema_version: "1.0",
    verdict: "GO",
    issue_id: "issue-abc",
    commit_sha: "abc1234def",
    evidence_hash: "deadbeef",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });

  it("case 19: two valid fenced JSON blocks → null (exactly-one violated)", () => {
    const p = makeValidPayload();
    const block = `\`\`\`json\n${JSON.stringify(p)}\n\`\`\``;
    const body = `${block}\n\nSome text\n\n${block}`;
    const result = extractAttestationFromCommentBody(body);
    expect(result).toBeNull();
  });

  it("case 20: one valid fenced JSON + one invalid schema block → returns valid one", () => {
    const validPayload = makeValidPayload();
    const invalidBlock = `\`\`\`json\n${JSON.stringify({ not_an_attestation: true })}\n\`\`\``;
    const validBlock = `\`\`\`json\n${JSON.stringify(validPayload)}\n\`\`\``;
    const body = `${invalidBlock}\n\n${validBlock}`;
    const result = extractAttestationFromCommentBody(body);
    expect(result).not.toBeNull();
    expect(result?.verdict).toBe("GO");
    expect(result?.issue_id).toBe("issue-abc");
  });
});

describe("computeEvidenceHash", () => {
  it("case 14: same input → same hash; output_files order independent", () => {
    const h1 = computeEvidenceHash({
      commit_sha: "abc1234",
      output_files: ["file-a.txt", "file-b.txt"],
      verification_command: "pnpm test",
      verification_output: "All tests passed",
    });
    const h2 = computeEvidenceHash({
      commit_sha: "abc1234",
      output_files: ["file-b.txt", "file-a.txt"], // reversed order
      verification_command: "pnpm test",
      verification_output: "All tests passed",
    });
    expect(h1).toBe(h2);
    expect(typeof h1).toBe("string");
    expect(h1.length).toBe(64); // sha256 hex
  });
});
