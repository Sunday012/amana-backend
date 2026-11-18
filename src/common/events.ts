/** PRD section 10 — internal queue event names. */
export const EVENTS = {
  agreementCreated: 'agreement.created',
  agreementApproved: 'agreement.approved',
  paymentConfirmed: 'payment.confirmed',
  deliveryUpdated: 'delivery.updated',
  evidenceReceived: 'evidence.received',
  milestoneReleasable: 'milestone.releasable',
  agreementReleasable: 'agreement.releasable',
  payoutSent: 'payout.sent',
  payoutFailed: 'payout.failed',
  disputeOpened: 'dispute.opened',
  disputeRuled: 'dispute.ruled',
  agreementCompleted: 'agreement.completed',
  agreementExpired: 'agreement.expired',
} as const;

export type AmanaEvent = (typeof EVENTS)[keyof typeof EVENTS];

export const QUEUES = {
  events: 'amana-events',
  notifications: 'amana-notifications',
  payouts: 'amana-payouts',
  reconcile: 'amana-reconcile',
} as const;

export interface EventPayload {
  event: AmanaEvent;
  agreementId: string;
  milestoneId?: string;
  actor?: string;
  data?: Record<string, unknown>;
}
