import { z } from 'zod';

const amountMinor = z
  .number()
  .int('Amounts are integers in minor units (kobo)')
  .positive('Amount must be greater than zero');

export const createTradeSchema = z.object({
  title: z.string().min(2).max(140),
  amount: amountMinor,
  currency: z.string().length(3).default('NGN'),
  buyerPhone: z.string().min(7),
  deliveryTerms: z.string().max(500).optional(),
  pickupAddress: z.string().max(300).optional(),
  dropoffAddress: z.string().max(300).optional(),
  createdVia: z.enum(['WEB', 'WHATSAPP', 'API', 'DISCORD']).default('WEB'),
  autoReleaseHours: z.number().int().min(1).max(168).optional(),
});
export type CreateTradeDto = z.infer<typeof createTradeSchema>;

export const milestoneSchema = z.object({
  title: z.string().min(2).max(140),
  amount: amountMinor,
  conditions: z.array(z.string()).min(1),
  verification: z.string().default('client_approval'),
});

export const createMilestoneAgreementSchema = z.object({
  title: z.string().min(2).max(140),
  freelancerPhone: z.string().min(7),
  currency: z.string().length(3).default('NGN'),
  totalAmount: amountMinor,
  milestones: z.array(milestoneSchema).min(1),
  disputeTerms: z.string().max(500).optional(),
  aiGenerated: z.boolean().default(false),
  createdVia: z.enum(['WEB', 'WHATSAPP', 'API', 'DISCORD']).default('WEB'),
});
export type CreateMilestoneAgreementDto = z.infer<typeof createMilestoneAgreementSchema>;

export const patchTermsSchema = z.object({
  totalAmount: amountMinor.optional(),
  milestones: z.array(milestoneSchema).optional(),
  deliveryTerms: z.string().max(500).optional(),
  disputeTerms: z.string().max(500).optional(),
});

const geoPoint = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

export const deliverySchema = z.object({
  pickupAddress: z.string().min(3),
  dropoffAddress: z.string().min(3),
  itemDescription: z.string().min(2).max(200),
  // Required by Chowdeck Relay, which quotes on coordinates. Optional here so
  // fake delivery mode still works from a plain address.
  pickupPoint: geoPoint.optional(),
  dropoffPoint: geoPoint.optional(),
});

export const confirmSchema = z.object({
  outcome: z.enum(['CONFIRM', 'PROBLEM']),
  note: z.string().max(500).optional(),
});

export const disputeSchema = z.object({
  reason: z.string().min(5).max(1000),
  milestoneId: z.string().uuid().optional(),
  evidenceUrl: z.string().url().optional(),
});

export const milestoneEvidenceSchema = z.object({
  type: z.enum(['GITHUB', 'UPLOAD']).default('UPLOAD'),
  prUrl: z.string().url().optional(),
  screenshots: z.array(z.string().url()).max(10).default([]),
  note: z.string().max(1000).optional(),
});

export const compileSchema = z.object({
  description: z.string().min(10).max(4000),
  currency: z.string().length(3).default('NGN'),
  budgetAmount: amountMinor.optional(),
});
