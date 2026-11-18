import { EVENTS } from '../../common/events';

export interface TemplatePair {
  /** Message for the payee (seller / freelancer). */
  payee: string;
  /** Message for the payer (buyer / client). */
  payer: string;
}

/** PRD section 8 — notifications the bot must send, both parties, every state. */
export const TEMPLATES: Record<string, TemplatePair> = {
  [EVENTS.agreementCreated]: {
    payee: 'Your protected order "{title}" is ready. Share this link with the buyer: {link}',
    payer: 'You have been invited to a protected order: "{title}" for {amount}. Review it here: {link}',
  },
  [EVENTS.agreementApproved]: {
    payee: 'The buyer accepted the terms for "{title}". Waiting for payment.',
    payer: 'Terms accepted for "{title}". Pay {amount} now to fund it: {link}',
  },
  [EVENTS.paymentConfirmed]: {
    payee: 'Payment confirmed. {amount} is held by Amana for "{title}". Hand the item to Chowdeck.',
    payer: 'Payment confirmed. {amount} is held safely until you confirm delivery.',
  },
  [EVENTS.deliveryUpdated]: {
    payee: 'Delivery update for "{title}": {status}.',
    payer: 'Your item for "{title}" is on the way. Track it: {link}',
  },
  [EVENTS.evidenceReceived]: {
    payee: 'Evidence submitted for "{title}". Awaiting verification.',
    payer: 'New evidence was submitted for "{title}". Review it: {link}',
  },
  [EVENTS.agreementReleasable]: {
    payee: 'All conditions met for "{title}". Payout is being released.',
    payer: 'Thank you. The payout for "{title}" is being released to the seller.',
  },
  [EVENTS.milestoneReleasable]: {
    payee: 'Milestone verified on "{title}". Payout is being released.',
    payer: 'A milestone on "{title}" met all its conditions. Payment is being released.',
  },
  [EVENTS.payoutSent]: {
    payee: 'Payout sent: {amount} for "{title}". Receipt: {link}',
    payer: 'Payout sent to the seller for "{title}". Receipt: {link}',
  },
  [EVENTS.payoutFailed]: {
    payee: 'The payout for "{title}" did not go through. We are retrying; no action needed.',
    payer: 'The payout for "{title}" is still processing. Your funds remain held.',
  },
  [EVENTS.disputeOpened]: {
    payee: 'A dispute was opened on "{title}". The payout is locked pending review.',
    payer: 'Your dispute on "{title}" is open. The payout is locked pending review.',
  },
  [EVENTS.disputeRuled]: {
    payee: 'The dispute on "{title}" has been ruled: {status}.',
    payer: 'The dispute on "{title}" has been ruled: {status}.',
  },
  [EVENTS.agreementCompleted]: {
    payee: 'Completed. Payout sent for "{title}". Receipt: {link}',
    payer: 'Completed. Here is your receipt for "{title}": {link}',
  },
  [EVENTS.agreementExpired]: {
    payee: 'The order "{title}" expired without payment.',
    payer: 'The order "{title}" expired. No money was taken.',
  },
};

/** "Delivered" needs the reply prompt, which only applies to the buyer. */
export const DELIVERED_PROMPT =
  'Your item for "{title}" is delivered. Reply 1 to confirm, 2 to report a problem.';

export function render(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => values[key] ?? '');
}
