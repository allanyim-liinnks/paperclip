import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';

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
