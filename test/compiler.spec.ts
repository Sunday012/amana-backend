import { describe, expect, it } from 'vitest';
import { compiledTermsSchema } from '../src/modules/compiler/compiler.schema';
import { CompilerService } from '../src/modules/compiler/compiler.service';

const valid = {
  total_amount: 10_000_000,
  currency: 'NGN',
  milestones: [
    { title: 'Homepage completed', amount: 5_000_000, conditions: ['client_approval'], verification: 'client_approval' },
    { title: 'Website deployed', amount: 5_000_000, conditions: ['tests_pass', 'client_approval'], verification: 'automated_test' },
  ],
  required_approvals: ['payer', 'payee'],
  dispute_terms: 'Payout paused; admin reviews evidence from both parties',
};

describe('AI compiler output validation', () => {
  it('accepts well-formed terms', () => {
    expect(compiledTermsSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects milestones that do not sum to the total', () => {
    const bad = { ...valid, milestones: [{ ...valid.milestones[0], amount: 4_000_000 }, valid.milestones[1]] };
    const result = compiledTermsSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('rejects an unknown condition the engine cannot verify', () => {
    const bad = {
      ...valid,
      milestones: [{ ...valid.milestones[0], conditions: ['vibes_are_good'] }, valid.milestones[1]],
    };
    expect(compiledTermsSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an empty milestone list', () => {
    expect(compiledTermsSchema.safeParse({ ...valid, milestones: [] }).success).toBe(false);
  });

  it('rejects negative or fractional amounts', () => {
    expect(
      compiledTermsSchema.safeParse({
        ...valid,
        milestones: [{ ...valid.milestones[0], amount: -1 }, valid.milestones[1]],
      }).success,
    ).toBe(false);
  });
});

describe('milestone amount reconciliation', () => {
  const terms = (total: number, amounts: number[]) => ({
    total_amount: total,
    milestones: amounts.map((amount) => ({ amount })),
  });

  it('absorbs a rounding-sized gap into the last milestone', () => {
    const out = CompilerService.reconcileAmounts(terms(10_000_000, [3_333_333, 3_333_333, 3_333_333])) as {
      milestones: { amount: number }[];
    };
    expect(out.milestones.reduce((s, m) => s + m.amount, 0)).toBe(10_000_000);
    expect(out.milestones[2].amount).toBe(3_333_334);
  });

  it('leaves a real disagreement alone so the schema rejects it', () => {
    const out = CompilerService.reconcileAmounts(terms(10_000_000, [2_000_000, 2_000_000])) as {
      milestones: { amount: number }[];
    };
    expect(out.milestones.reduce((s, m) => s + m.amount, 0)).toBe(4_000_000);
  });

  it('never drives a milestone to zero or negative', () => {
    const out = CompilerService.reconcileAmounts(terms(1_000, [900, 100 + 15])) as {
      milestones: { amount: number }[];
    };
    expect(out.milestones.every((m) => m.amount > 0)).toBe(true);
  });

  it('ignores anything that is not shaped like terms', () => {
    expect(CompilerService.reconcileAmounts({ nonsense: true })).toEqual({ nonsense: true });
    expect(CompilerService.reconcileAmounts(null)).toBeNull();
  });
});
