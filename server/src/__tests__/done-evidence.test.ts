import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateDoneEvidence } from "../lib/done-evidence.js";

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
  });
});
