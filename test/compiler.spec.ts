import { describe, expect, it } from 'vitest';
import { compiledTermsSchema } from '../src/modules/compiler/compiler.schema';

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
