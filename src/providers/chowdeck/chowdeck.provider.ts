import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  DeliveryEvent,
  DeliveryProvider,
  DeliveryRequest,
  DeliveryResult,
  ParsedDeliveryEvent,
} from './chowdeck.types';

/** Relay's event names, mapped onto our delivery states. */
const EVENT_MAP: Record<string, DeliveryEvent> = {
  ORDER_CREATED: 'CREATED',
  ORDER_ASSIGNED: 'CREATED',
  ORDER_AWAITING_PICKUP: 'CREATED',
  ORDER_PICKED_UP: 'PICKED_UP',
  ORDER_ARRIVED_AT_CUSTOMER_LOCATION: 'IN_TRANSIT',
  ORDER_COMPLETE: 'DELIVERED',
  // Not in Relay's documented event list, but mapped so a cancellation or a
  // failed run still lands somewhere sane if they do send one.
  ORDER_CANCELLED: 'FAILED',
  ORDER_FAILED: 'FAILED',
  ORDER_RETURNED: 'RETURNED',
};

@Injectable()
export class FakeChowdeckProvider extends DeliveryProvider {
  private readonly logger = new Logger(FakeChowdeckProvider.name);

  async createDelivery(req: DeliveryRequest): Promise<DeliveryResult> {
    const deliveryId = `fake-dlv-${randomUUID().slice(0, 8)}`;
    this.logger.warn(`[fake] delivery ${deliveryId} for agreement ${req.agreementId}`);
    return { deliveryId, trackingUrl: `https://example.invalid/track/${deliveryId}`, feeMinor: 0n };
  }

  verifyWebhook(): boolean {
    return true;
  }

  /** Accepts both our own simple test shape and Relay's real one. */
  parseWebhook(body: Record<string, unknown>): ParsedDeliveryEvent | null {
    const payload = (body.payload ?? {}) as Record<string, unknown>;
    const deliveryId = String(body.delivery_id ?? body.id ?? payload.reference ?? payload.id ?? '');
    if (!deliveryId) return null;

    const category = String(body.category ?? '');
    const status =
      EVENT_MAP[category] ??
      (String(body.status ?? '').toUpperCase().replace(/\s/g, '_') as DeliveryEvent);
    if (!status) return null;

    return {
      deliveryId,
      status,
      eventId: String(body.event_id ?? `${deliveryId}:${category || body.status}`),
    };
  }
}

/**
 * Relay by Chowdeck — on-demand last-mile delivery.
 *
 * Creating a delivery is two calls, not one: quote first, then dispatch
 * against that quote's id.
 *
 *   POST /relay/delivery/fee  -> data.id (fee_id), data.total_amount
 *   POST /relay/delivery      -> data.id, data.reference, data.status
 *
 * Relay quotes on coordinates, so a free-text address is not enough; the
 * caller must supply lat/lng for both ends.
 *
 * Delivery fees are charged to the Relay wallet, so that wallet needs a
 * balance or dispatch fails.
 *
 * NO SANDBOX. Chowdeck's docs describe a single API key, a single base URL and
 * no test mode. A call to createDelivery dispatches a real rider and bills the
 * real wallet, so DELIVERY_MODE stays "fake" unless a dispatch is intended.
 *
 * Auth is confirmed: Authorization: Bearer <secret key>.
 * https://chowdeck-api.readme.io/docs/authentication
 */
@Injectable()
export class ChowdeckProvider extends DeliveryProvider {
  private readonly logger = new Logger(ChowdeckProvider.name);

  constructor(private readonly config: ConfigService) {
    super();
  }

  private get baseUrl(): string {
    return this.config.get<string>('CHOWDECK_BASE_URL') ?? 'https://api.chowdeck.com';
  }

  private async call<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.get<string>('CHOWDECK_API_KEY') ?? ''}`,
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    let json: T & { status?: string; message?: string };
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Chowdeck ${path} returned a non-JSON response: ${text.slice(0, 200)}`);
    }

    if (!response.ok || json.status === 'failed') {
      this.logger.error(`Chowdeck ${path} failed: ${response.status} ${json.message ?? ''}`);
      throw new Error(`Chowdeck ${path} failed: ${json.message ?? response.status}`);
    }
    return json;
  }

  /** Relay wants a local 11-digit number; we store E.164. */
  private static localPhone(phone: string): string {
    const digits = phone.replace(/\D/g, '');
    if (digits.startsWith('234')) return `0${digits.slice(3)}`;
    return digits;
  }

  async createDelivery(req: DeliveryRequest): Promise<DeliveryResult> {
    if (!req.pickupPoint || !req.dropoffPoint) {
      throw new Error(
        'Chowdeck Relay quotes on coordinates: pickupPoint and dropoffPoint are required',
      );
    }

    // 1. Quote. The fee id returned here is what authorises the dispatch.
    const quote = await this.call<{
      data: { id: number; total_amount: number; delivery_amount: number };
    }>('/relay/delivery/fee', {
      source_address: req.pickupPoint,
      destination_address: req.dropoffPoint,
      source_address_string: req.pickupAddress,
      destination_address_string: req.dropoffAddress,
      estimated_order_amount: Number(req.itemValueMinor ?? 0n),
    });

    // 2. Dispatch against the quote.
    const delivery = await this.call<{
      data: { id: number; reference: string; status: string; delivery_price: number };
    }>('/relay/delivery', {
      fee_id: quote.data.id,
      item_type: req.itemDescription.slice(0, 100),
      user_action: 'sending',
      reference: req.agreementId,
      estimated_order_amount: Number(req.itemValueMinor ?? 0n),
      source_contact: {
        name: req.senderName,
        phone: ChowdeckProvider.localPhone(req.senderPhone),
        country_code: 'NG',
      },
      destination_contact: {
        name: req.recipientName,
        phone: ChowdeckProvider.localPhone(req.recipientPhone),
        country_code: 'NG',
      },
    });

    return {
      deliveryId: delivery.data.reference ?? String(delivery.data.id),
      feeMinor: BigInt(quote.data.total_amount ?? 0),
    };
  }

  verifyWebhook(rawBody: string, headers: Record<string, unknown>): boolean {
    const secret = this.config.get<string>('CHOWDECK_WEBHOOK_SECRET');
    if (!secret) return false;
    const provided = String(headers['x-chowdeck-signature'] ?? '');
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Relay sends { category, description, payload } on every event. */
  parseWebhook(body: Record<string, unknown>): ParsedDeliveryEvent | null {
    const category = String(body.category ?? '');
    const status = EVENT_MAP[category];
    if (!status) {
      this.logger.log(`Ignoring unmapped Chowdeck event ${category}`);
      return null;
    }

    const payload = (body.payload ?? {}) as Record<string, unknown>;
    const deliveryId = String(payload.reference ?? payload.id ?? '');
    if (!deliveryId) return null;

    return {
      deliveryId,
      status,
      eventId: String(payload.id ?? deliveryId) + `:${category}`,
    };
  }
}
