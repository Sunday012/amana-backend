import { z } from 'zod';

/** PRD section 10 — the AI compiler's output schema. Untrusted input. */
export const compiledTermsSchema = z
  .object({
    total_amount: z.number().int().positive(),
    currency: z.string().length(3),
    milestones: z
      .array(
        z.object({
          title: z.string().min(2).max(140),
          amount: z.number().int().positive(),
          conditions: z.array(z.enum(['tests_pass', 'client_approval', 'evidence_submitted'])).min(1),
          verification: z.enum(['client_approval', 'automated_test', 'manual_review']),
        }),
      )
      .min(1)
      .max(12),
    required_approvals: z.array(z.enum(['payer', 'payee'])).min(1),
    dispute_terms: z.string().min(5).max(500),
  })
  .refine(
    (value) => value.milestones.reduce((sum, m) => sum + m.amount, 0) === value.total_amount,
    { message: 'Milestone amounts must sum to total_amount' },
  );

export type CompiledTerms = z.infer<typeof compiledTermsSchema>;
