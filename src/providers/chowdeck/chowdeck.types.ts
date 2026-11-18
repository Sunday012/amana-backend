export interface GeoPoint {
  latitude: number;
  longitude: number;
}

export interface DeliveryRequest {
  agreementId: string;
  pickupAddress: string;
  dropoffAddress: string;
  /** Relay quotes and dispatches on coordinates; the strings are labels only. */
  pickupPoint?: GeoPoint;
  dropoffPoint?: GeoPoint;
  itemDescription: string;
  /** Used for Relay's safety coverage, in minor units. */
  itemValueMinor?: bigint;
  senderName: string;
  senderPhone: string;
  recipientName: string;
  recipientPhone: string;
}

export interface DeliveryResult {
  deliveryId: string;
  trackingUrl?: string;
  /** What Chowdeck charges for this run, in minor units. */
  feeMinor?: bigint;
}

/** Our delivery states, mapped from whatever the provider calls them. */
export type DeliveryEvent =
  | 'CREATED'
  | 'PICKED_UP'
  | 'IN_TRANSIT'
  | 'DELIVERED'
  | 'FAILED'
  | 'RETURNED';

export interface ParsedDeliveryEvent {
  deliveryId: string;
  status: DeliveryEvent;
  eventId: string;
}

export abstract class DeliveryProvider {
  abstract createDelivery(req: DeliveryRequest): Promise<DeliveryResult>;
  abstract verifyWebhook(rawBody: string, headers: Record<string, unknown>): boolean;
  /** Pulls our delivery id and state out of the provider's webhook body. */
  abstract parseWebhook(body: Record<string, unknown>): ParsedDeliveryEvent | null;
}
