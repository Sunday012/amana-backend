import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  CollectionRequest,
  CollectionResult,
  CollectionStatus,
  PaymentProvider,
  PayoutRequest,
  PayoutResult,
} from './paga.types';

/**
 * Real Paga Engine adapter.
 *
 * Paga is two products with two auth schemes, and we use both:
 *
 *   Collect  (beta-collect.paga.com) — money in.  HTTP Basic: public:secret,
 *            plus a `hash` header.
 *   Business (beta.mypaga.com)       — money out. `principal` / `credentials`
 *            headers, plus the same `hash` header.
 *
 * The hash is SHA-512 over that operation's parameters concatenated in a
 * documented order with the hash key appended — no separators, and NOT an HMAC.
 * Each operation has its own parameter sequence; a wrong order fails as a
 * signature error rather than a validation one.
 *
 * Every call must also originate from a whitelisted IP, in Sandbox as well as
 * Live (Developer Tools -> IP Whitelist in the portal).
 *
 * Docs: https://developer-docs.paga.com/docs/authentication
 */
@Injectable()
export class PagaProvider extends PaymentProvider {
  private readonly logger = new Logger(PagaProvider.name);

  constructor(private readonly config: ConfigService) {
    super();
  }

  private get collectBaseUrl(): string {
    return this.config.get<string>('PAGA_COLLECT_BASE_URL') ?? 'https://beta-collect.paga.com';
  }

  private get businessBaseUrl(): string {
    return this.config.get<string>('PAGA_BUSINESS_BASE_URL') ?? 'https://beta.mypaga.com';
  }

  /** SHA-512 over the ordered parameters with the hash key appended. */
  private signature(parts: (string | undefined)[]): string {
    const hashKey = this.config.get<string>('PAGA_HMAC_KEY') ?? '';
    return createHash('sha512')
      .update(parts.map((part) => part ?? '').join('') + hashKey)
      .digest('hex');
  }

  /** Collect and Direct Debit: HTTP Basic. */
  private async collectCall<T>(
    path: string,
    body: Record<string, unknown>,
    hashParts: (string | undefined)[],
  ): Promise<T> {
    const credentials = Buffer.from(
      `${this.config.get<string>('PAGA_PUBLIC_KEY') ?? ''}:${this.config.get<string>('PAGA_SECRET_KEY') ?? ''}`,
    ).toString('base64');

    return this.send<T>(`${this.collectBaseUrl}${path}`, body, {
      Authorization: `Basic ${credentials}`,
      hash: this.signature(hashParts),
    });
  }

  /** Business API: credential headers, under /paga-webservices/business-rest/secured. */
  private async businessCall<T>(
    operation: string,
    body: Record<string, unknown>,
    hashParts: (string | undefined)[],
  ): Promise<T> {
    return this.send<T>(
      `${this.businessBaseUrl}/paga-webservices/business-rest/secured/${operation}`,
      body,
      {
        principal: this.config.get<string>('PAGA_PUBLIC_KEY') ?? '',
        credentials: this.config.get<string>('PAGA_SECRET_KEY') ?? '',
        hash: this.signature(hashParts),
      },
    );
  }

  private async send<T>(
    url: string,
    body: Record<string, unknown>,
    headers: Record<string, string>,
  ): Promise<T> {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    let json: T & {
      responseCode?: number;
      statusCode?: string | number;
      message?: string;
      statusMessage?: string;
    };
    try {
      json = JSON.parse(text);
    } catch {
      this.logger.error(`Paga ${url} returned non-JSON: ${text.slice(0, 200)}`);
      throw new Error(`Paga ${url} returned a non-JSON response`);
    }

    if (!response.ok) {
      const detail = json.message ?? json.statusMessage ?? text.slice(0, 200);
      this.logger.error(`Paga ${url} failed: HTTP ${response.status} ${detail}`);
      // Surfaced rather than swallowed: a provider rejection is not our bug,
      // and the message is the only way to tell apart auth, IP and payload
      // problems from the outside.
      throw new BadGatewayException({
        message: 'Paga rejected the request',
        provider: { endpoint: url, httpStatus: response.status, detail },
      });
    }

    // Paga reports business failures in the body, not the HTTP status, and the
    // two APIs name the field differently: Business uses a numeric
    // `responseCode`, Collect a string `statusCode`. Either non-zero is a
    // rejection. (On a status check this is the *envelope* code — whether the
    // lookup worked — not whether the payment is paid.)
    const envelopeCode = json.responseCode ?? json.statusCode;
    if (envelopeCode !== undefined && String(envelopeCode) !== '0') {
      const detail = json.message ?? json.statusMessage ?? '';
      this.logger.error(`Paga ${url} rejected: code ${envelopeCode} ${detail}`);
      throw new BadGatewayException({
        message: 'Paga rejected the request',
        provider: { endpoint: url, code: String(envelopeCode), detail },
      });
    }
    return json;
  }

  // ------------------------------------------------------------ money in

  /**
   * Collect payment request. Required by Paga and easy to miss: names for both
   * parties, a callback URL, a payment method, and the two fee shares, which
   * must add up to 1.
   */
  async createCollection(req: CollectionRequest): Promise<CollectionResult> {
    const callBackUrl = this.callbackUrl();
    if (!callBackUrl) {
      throw new Error(
        'PUBLIC_API_URL must be set: Paga requires a callBackUrl on every payment request',
      );
    }

    // Hash and body must agree on the amount exactly as JSON renders it, so
    // derive both from one number rather than formatting twice.
    const amount = Number((Number(req.amountMinor) / 100).toFixed(2));
    const payerEmail = req.payerEmail ?? '';

    // Who absorbs the collection fee. Defaulting the payer to the whole share
    // means we receive the agreement total intact, so the held balance always
    // matches what the payout guard expects.
    const payerFeeShare = Number(this.config.get<string>('PAGA_PAYER_FEE_SHARE') ?? 1);

    const result = await this.collectCall<{
      referenceNumber?: string;
      transactionId?: string;
      paymentUrl?: string;
      redirectUrl?: string;
    }>(
      '/paymentRequest',
      {
        referenceNumber: req.reference,
        amount,
        currency: req.currency,
        payer: {
          name: req.payerName,
          phoneNumber: req.payerPhone,
          ...(payerEmail ? { email: payerEmail } : {}),
        },
        payee: { name: req.payeeName },
        payerCollectionFeeShare: payerFeeShare,
        payeeCollectionFeeShare: Number((1 - payerFeeShare).toFixed(2)),
        callBackUrl,
        paymentMethods: [this.config.get<string>('PAGA_PAYMENT_METHOD') ?? 'BANK_TRANSFER'],
        isSuppressMessages: false,
        narration: req.description.slice(0, 100),
      },
      // referenceNumber + amount + currency + payer.phoneNumber + payer.email
      [req.reference, String(amount), req.currency, req.payerPhone, payerEmail],
    );

    return {
      reference: result.referenceNumber ?? req.reference,
      providerRef: result.transactionId ?? req.reference,
      checkoutUrl: result.paymentUrl ?? result.redirectUrl ?? '',
      settled: false,
    };
  }

  /**
   * The envelope statusCode says whether the lookup worked; data.statusCode
   * says whether the money actually arrived.
   */
  async getCollectionStatus(reference: string): Promise<CollectionStatus> {
    const result = await this.collectCall<{
      data?: {
        statusCode?: string | number;
        requestAmount?: number;
        totalPaymentAmount?: number;
        currency?: string;
        transactionId?: string;
      };
    }>('/status', { referenceNumber: reference }, [reference]);

    const data = result.data ?? {};
    const settled = String(data.statusCode ?? '') === '0';
    const paid = data.totalPaymentAmount ?? 0;

    return {
      reference,
      settled,
      amountMinor: BigInt(Math.round(Number(paid) * 100)),
      currency: data.currency ?? 'NGN',
      providerTxnId: data.transactionId,
      raw: result as Record<string, unknown>,
    };
  }

  // ----------------------------------------------------------- money out

  /**
   * depositToBank on the Business API. The idempotency key doubles as Paga's
   * referenceNumber, so a retry reuses it and can never pay twice.
   */
  async sendPayout(req: PayoutRequest): Promise<PayoutResult> {
    const amount = (Number(req.amountMinor) / 100).toFixed(2);

    if (!req.destinationBankUuid) {
      return {
        status: 'FAILED',
        failureReason: 'No destination bank on file for the payee',
        raw: {},
      };
    }

    try {
      const result = await this.businessCall<{
        referenceNumber?: string;
        transactionId?: string;
        message?: string;
        destinationAccountHolderNameAtBank?: string;
        fee?: number;
      }>(
        'depositToBank',
        {
          referenceNumber: req.idempotencyKey,
          amount,
          currency: req.currency,
          destinationBankUUID: req.destinationBankUuid,
          destinationBankAccountNumber: req.recipient,
          statusCallbackUrl: this.callbackUrl(),
          remarks: req.memo,
        },
        // referenceNumber + amount + destinationBankUUID + destinationBankAccountNumber
        [req.idempotencyKey, amount, req.destinationBankUuid, req.recipient],
      );

      return {
        status: 'SENT',
        providerRef: result.transactionId,
        raw: result as Record<string, unknown>,
      };
    } catch (error) {
      // A timeout or transport error is NOT a failure: the money may well have
      // moved. Stay PENDING so the reconciler re-checks by reference before any
      // retry, which reuses the same key.
      return {
        status: 'PENDING',
        failureReason: (error as Error).message,
        raw: { error: (error as Error).message },
      };
    }
  }

  private callbackUrl(): string | undefined {
    const base = this.config.get<string>('PUBLIC_API_URL');
    return base ? `${base}/webhooks/paga` : undefined;
  }

  verifyWebhook(rawBody: string, headers: Record<string, unknown>): boolean {
    const secret = this.config.get<string>('PAGA_WEBHOOK_SECRET');
    if (!secret) return false;
    const provided = String(headers['x-paga-signature'] ?? headers['hash'] ?? '');
    const expected = createHmac('sha512', secret).update(rawBody).digest('hex');
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
