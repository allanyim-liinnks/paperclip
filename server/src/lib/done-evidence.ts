import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

// P1-3: module-level typo warning (runs once at import time)
const _MODE_RAW = process.env.DONE_EVIDENCE_MODE;
if (_MODE_RAW !== undefined && _MODE_RAW !== 'dry-run' && _MODE_RAW !== 'enforce') {
  // eslint-disable-next-line no-console
  console.warn(`[done-evidence] unknown DONE_EVIDENCE_MODE="${_MODE_RAW}" — falling back to dry-run`);
}
// P1-7: warn when enforce mode is active but VERIFIER_AGENT_ID is not set
if (_MODE_RAW === 'enforce' && !process.env.VERIFIER_AGENT_ID) {
  // eslint-disable-next-line no-console
  console.error('[done-evidence] DONE_EVIDENCE_MODE=enforce but VERIFIER_AGENT_ID is not set — all status=done PATCHs will be rejected');
}

export const doneEvidenceSchema = z.object({
  commit_sha: z.string().regex(/^[a-f0-9]{7,40}$/).optional(),
  output_files: z.array(z.string()).optional(),
  verification_command: z.string().optional(),
  verification_output: z.string().optional(),
  notes: z.string().optional(),
}).passthrough();

export type DoneEvidence = z.infer<typeof doneEvidenceSchema>;

export type EvidenceMode = 'dry-run' | 'enforce';

export interface EvidenceValidationResult {
  ok: boolean;
  reasons: string[];
  mode: EvidenceMode;
}

export function getEvidenceMode(): EvidenceMode {
  const raw = process.env.DONE_EVIDENCE_MODE ?? 'dry-run';
  return raw === 'enforce' ? 'enforce' : 'dry-run';
}

export interface EvidenceContext {
  issueId: string;
  logger?: { warn?: (...args: any[]) => void; info?: (...args: any[]) => void };
  cwd?: string;
}

export function validateDoneEvidence(
  evidence: unknown,
  ctx: EvidenceContext,
): EvidenceValidationResult {
  const mode = getEvidenceMode();
  const reasons: string[] = [];

  if (evidence == null || typeof evidence !== 'object') {
    reasons.push('missing evidence object');
  } else {
    const parsed = doneEvidenceSchema.safeParse(evidence);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        reasons.push(`${issue.path.join('.') || 'evidence'}: ${issue.message}`);
      }
    } else {
      const e = parsed.data;

      // P1-1: require at least one meaningful field
      const hasAny =
        (typeof e.commit_sha === 'string' && e.commit_sha.length > 0) ||
        (Array.isArray(e.output_files) && e.output_files.length > 0) ||
        (typeof e.verification_command === 'string' && e.verification_command.length > 0);
      if (!hasAny) {
        reasons.push('evidence requires at least one of: commit_sha, output_files, verification_command');
      }

      if (e.output_files && e.output_files.length > 0) {
        const baseDir = ctx.cwd ?? process.cwd();
        for (const rel of e.output_files) {
          const abs = path.isAbsolute(rel) ? rel : path.resolve(baseDir, rel);
          if (!fs.existsSync(abs)) {
            reasons.push(`output_file not found: ${rel}`);
          }
        }
      }
      if (e.verification_command && !e.verification_output) {
        reasons.push('verification_command provided without verification_output');
      }
    }
  }

  if (mode === 'dry-run' && reasons.length > 0) {
    ctx.logger?.warn?.(`[done-evidence] dry-run violations`, { issueId: ctx.issueId, reasons });
  }

  return {
    ok: mode === 'dry-run' ? true : reasons.length === 0,
    reasons,
    mode,
  };
}

// ── Phase 3.2: Verifier attestation ──────────────────────────────────────────

export interface AttestationPayload {
  schema_version: string;
  verdict: 'GO' | 'NO-GO';
  issue_id: string;
  commit_sha: string;
  evidence_hash: string;
  evidence_payload?: Record<string, unknown>;
  expires_at: string;
  verifier_run_id?: string;
  reasons?: string[];
  needs_higher_model?: boolean;
}

export interface AttestationContext {
  /** 코멘트 작성자 agentId 가 일치해야 함 */
  expectedVerifierAgentId: string | undefined;
  /** PATCH 대상 issue.id */
  expectedIssueId: string;
  /** PATCH evidence.commit_sha */
  expectedCommitSha?: string;
  /** PATCH evidence 자체 — hash 검증용. computeEvidenceHash 적용 */
  actualEvidence?: {
    commit_sha?: string;
    output_files?: string[];
    verification_command?: string;
    verification_output?: string;
  };
  /** 코멘트 조회 함수 (의존성 주입) */
  fetchComment: (commentId: string) => Promise<{ id: string; authorAgentId: string | null; body: string } | null>;
  /** 현재 시각 — 테스트 주입용 */
  now?: () => Date;
}

export interface AttestationResult {
  ok: boolean;
  reasons: string[];
  attestation?: AttestationPayload;
}

export function computeEvidenceHash(payload: {
  commit_sha?: string;
  output_files?: string[];
  verification_command?: string;
  verification_output?: string;
}): string {
  const canonical = JSON.stringify({
    commit_sha: payload.commit_sha ?? '',
    output_files: Array.isArray(payload.output_files) ? [...payload.output_files].sort() : [],
    verification_command: payload.verification_command ?? '',
    verification_output: payload.verification_output ?? '',
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** 코멘트 body 에서 fenced JSON 블록 추출. exactly-one valid attestation 이어야 함. */
export function extractAttestationFromCommentBody(body: string): AttestationPayload | null {
  // 모든 ```json ... ``` 블록 추출
  const fencedRegex = /```json\s*([\s\S]*?)```/g;
  const matches: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = fencedRegex.exec(body)) !== null) {
    matches.push(match[1]);
  }

  // fenced 블록이 없으면 첫 { ... } 시도 (legacy)
  let candidates: string[];
  if (matches.length === 0) {
    const start = body.indexOf('{');
    if (start === -1) return null;
    candidates = [body.slice(start)];
  } else {
    candidates = matches;
  }

  const valid: AttestationPayload[] = [];
  for (const raw of candidates) {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) continue;
      if (typeof parsed.schema_version !== 'string') continue;
      if (parsed.verdict !== 'GO' && parsed.verdict !== 'NO-GO') continue;
      valid.push(parsed as AttestationPayload);
    } catch {
      continue;
    }
  }

  // exactly one valid attestation
  if (valid.length !== 1) return null;
  return valid[0];
}

export async function verifyAttestation(
  attestationId: string,
  ctx: AttestationContext,
): Promise<AttestationResult> {
  const reasons: string[] = [];
  const now = ctx.now ? ctx.now() : new Date();

  if (!ctx.expectedVerifierAgentId) {
    reasons.push('VERIFIER_AGENT_ID env not configured');
    return { ok: false, reasons };
  }

  const comment = await ctx.fetchComment(attestationId);
  if (!comment) {
    reasons.push(`attestation comment not found: ${attestationId}`);
    return { ok: false, reasons };
  }

  if (comment.authorAgentId !== ctx.expectedVerifierAgentId) {
    reasons.push('attestation author is not the verifier agent');
    return { ok: false, reasons };
  }

  const attestation = extractAttestationFromCommentBody(comment.body);
  if (!attestation) {
    reasons.push('attestation JSON not parseable from comment body');
    return { ok: false, reasons };
  }

  if (attestation.verdict !== 'GO') {
    reasons.push(`attestation verdict is ${attestation.verdict}`);
  }
  if (attestation.issue_id !== ctx.expectedIssueId) {
    reasons.push(`attestation issue_id mismatch (got ${attestation.issue_id}, expected ${ctx.expectedIssueId})`);
  }
  if (ctx.expectedCommitSha && attestation.commit_sha !== ctx.expectedCommitSha) {
    reasons.push(`attestation commit_sha mismatch`);
  }
  // P0-3: handle NaN / invalid date strings
  const expiryMs = new Date(attestation.expires_at).getTime();
  if (!Number.isFinite(expiryMs)) {
    reasons.push('attestation expires_at invalid or unparseable');
  } else if (expiryMs < now.getTime()) {
    reasons.push(`attestation expired at ${attestation.expires_at}`);
  }
  // P0-2: evidence_hash tamper check
  if (ctx.actualEvidence) {
    const expectedHash = computeEvidenceHash(ctx.actualEvidence);
    if (attestation.evidence_hash !== expectedHash) {
      reasons.push('attestation evidence_hash mismatch (PATCH evidence tampered or unrelated)');
    }
  }

  return {
    ok: reasons.length === 0,
    reasons,
    attestation,
  };
}
