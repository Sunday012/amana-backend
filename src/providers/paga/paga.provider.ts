import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  CollectionRequest,
  FundingEvent,
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

  /** Paga wants a local 11-digit number; we store E.164. */
  private static localPhone(phone: string): string {
    const digits = phone.replace(/\D/g, '');
    if (digits.startsWith('234')) return `0${digits.slice(3)}`;
    return digits;
  }

  /** SHA-512 over the ordered parameters with the hash key appended. */
  private signature(parts: (string | undefined)[]): string {
    const hashKey = this.config.get<string>('PAGA_HMAC_KEY') ?? '';
    return createHash('sha512')
      .update(parts.map((part) => part ?? '').join('') + hashKey)
      .digest('hex');
  }

  /**
   * Our permanent id for an agreement's account: 11-30 alphanumeric characters,
   * derived from the payment reference so both sides agree on it.
   */
  static accountReferenceFor(reference: string): string {
    return reference.replace(/[^a-zA-Z0-9]/g, '').slice(0, 30);
  }

  /** Collect reads: same auth, no body. */
  private async collectGet<T>(path: string, hashParts: (string | undefined)[]): Promise<T> {
    const credentials = Buffer.from(
      `${this.config.get<string>('PAGA_PUBLIC_KEY') ?? ''}:${this.config.get<string>('PAGA_SECRET_KEY') ?? ''}`,
    ).toString('base64');

    const response = await fetch(`${this.collectBaseUrl}${path}`, {
      method: 'GET',
      headers: {
        Authorization: `Basic ${credentials}`,
        hash: this.signature(hashParts),
      },
    });
    const text = await response.text();
    const json = JSON.parse(text) as T & { statusCode?: string; statusMessage?: string };
    if (!response.ok || (json.statusCode !== undefined && String(json.statusCode) !== '0')) {
      throw new Error(`Paga GET ${path} failed: ${json.statusMessage ?? response.status}`);
    }
    return json;
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
   * Money in is a *subsidiary account*: a dedicated Nigerian account number
   * for this agreement that the buyer transfers into from any bank. Omitting
   * autoSweep makes it ledger-backed, so Paga holds the funds there until we
   * move them — which is the escrow property the product depends on.
   *
   * Paga's payment-request product is not enabled on this account (every call
   * returns "system error"), so this is the money-in path.
   */
  async createCollection(req: CollectionRequest): Promise<CollectionResult> {
    const callbackUrl = this.callbackUrl();
    if (!callbackUrl) {
      throw new Error('PUBLIC_API_URL must be set: Paga needs a callback for funding events');
    }

    // accountReference must be 11-30 characters and is permanent per account.
    const accountReference = req.reference.replace(/[^a-zA-Z0-9]/g, '').slice(0, 30);
    const [firstName, ...rest] = (req.payerName || 'Amana Buyer').trim().split(/\s+/);
    const lastName = rest.join(' ') || 'Buyer';

    const result = await this.collectCall<{
      accountNumber?: string;
      accountReference?: string;
      statusMessage?: string;
    }>(
      '/subsidiary-accounts',
      {
        referenceNumber: req.reference,
        accountReference,
        // What the buyer sees as the account name in their bank app, so it has
        // to name us and the order rather than just the item.
        accountName: `Amana · ${req.description}`.slice(0, 100),
        firstName,
        lastName,
        phoneNumber: PagaProvider.localPhone(req.payerPhone),
        ...(req.payerEmail ? { email: req.payerEmail } : {}),
        status: 'ACTIVE',
        callbackUrl,
        // No autoSweep: hold the funds rather than settling them out.
      },
      // referenceNumber + accountReference + iifiNumber + autoSweep.bankPublicId
      // + autoSweep.destination + autoSweep.accountNumber + callbackUrl
      [req.reference, accountReference, '', '', '', '', callbackUrl],
    );

    return {
      reference: req.reference,
      providerRef: result.accountReference ?? accountReference,
      accountNumber: result.accountNumber,
      accountName: `Amana · ${req.description}`.slice(0, 100),
      bankName: 'Paga',
      settled: false,
    };
  }

  /**
   * Reading a subsidiary account back is not working on this sandbox yet, so
   * this reports "could not check" rather than "not paid" — the difference
   * matters, because the reconciler must not conclude a payment failed just
   * because the provider is unreachable.
   */
  async getCollectionStatus(reference: string): Promise<CollectionStatus> {
    const accountReference = PagaProvider.accountReferenceFor(reference);
    const requestRef = `BAL-${accountReference}`.slice(0, 40);
    try {
      // GET /subsidiary-accounts/{accountIdentifier}?referenceNumber=…
      // hash = referenceNumber + accountIdentifier
      const result = await this.collectGet<{ balance?: number; currency?: string }>(
        `/subsidiary-accounts/${accountReference}?referenceNumber=${encodeURIComponent(requestRef)}`,
        [requestRef, accountReference],
      );
      return {
        reference,
        settled: Number(result.balance ?? 0) > 0,
        checked: true,
        amountMinor: BigInt(Math.round(Number(result.balance ?? 0) * 100)),
        currency: result.currency ?? 'NGN',
        raw: result as Record<string, unknown>,
      };
    } catch (error) {
      this.logger.warn(`Could not read subsidiary account ${accountReference}: ${(error as Error).message}`);
      return {
        reference,
        settled: false,
        checked: false,
        amountMinor: 0n,
        currency: 'NGN',
        raw: { error: (error as Error).message },
      };
    }
  }

  /**
   * Funding callback. The signature covers the transaction, so a forged body
   * cannot credit an agreement.
   * hash = SHA-512(transactionReference + transactionDate + amount
   *                + accountNumber + timestamp + hashKey)
   */
  parseFunding(body: Record<string, unknown>): FundingEvent | null {
    const accountNumber = String(body.accountNumber ?? '');
    const amount = Number(body.amount ?? 0);
    if (!accountNumber || !(amount > 0)) return null;

    return {
      accountNumber,
      amountMinor: BigInt(Math.round(amount * 100)),
      providerTxnId: String(body.transactionReference ?? ''),
      eventId: String(
        body.transactionReference ?? body.fundingTransactionReference ?? `${accountNumber}:${amount}`,
      ),
    };
  }

  // ----------------------------------------------------------- money out

  /**
   * depositToBank on the Business API. The idempotency key doubles as Paga's
   * referenceNumber, so a retry reuses it and can never pay twice.
   */
  /**
   * Releasing held money is two steps, and both are idempotent on their
   * referenceNumber, so a retry after a timeout can neither double-debit the
   * agreement's account nor pay the seller twice:
   *
   *   1. charge the agreement's subsidiary account -> business balance
   *   2. depositToBank -> the seller
   *
   * If step 2 fails after step 1 succeeded, the money is in the business
   * balance and the payout stays PENDING for the reconciler; re-running
   * repeats step 1 as a no-op.
   */
  private async chargeHeldFunds(req: PayoutRequest): Promise<void> {
    if (!req.sourceReference) return;

    const accountReference = PagaProvider.accountReferenceFor(req.sourceReference);
    const amount = (Number(req.amountMinor) / 100).toFixed(2);
    const narration = req.memo.slice(0, 64);
    const chargeRef = `${req.idempotencyKey}-c`;

    await this.collectCall(
      `/subsidiary-accounts/${accountReference}/charge`,
      { referenceNumber: chargeRef, amount: Number(amount), currency: req.currency, narration },
      // referenceNumber + amount + currency + narration
      [chargeRef, String(Number(amount)), req.currency, narration],
    );
    this.logger.log(`Charged ${amount} from held account ${accountReference}`);
  }

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
      await this.chargeHeldFunds(req);

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

  /**
   * Funding callbacks carry x-paga-hash-v3, computed the same way as request
   * hashes: SHA-512 over ordered fields with the hash key appended.
   */
  verifyWebhook(rawBody: string, headers: Record<string, unknown>): boolean {
    const provided = String(
      headers['x-paga-hash-v3'] ?? headers['x-paga-signature'] ?? headers['hash'] ?? '',
    );
    if (!provided) return false;

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return false;
    }

    const timestamp = String(headers['x-paga-timestamp'] ?? body.timestamp ?? '');
    const expected = this.signature([
      String(body.transactionReference ?? ''),
      String(body.transactionDate ?? ''),
      String(body.amount ?? ''),
      String(body.accountNumber ?? ''),
      timestamp,
    ]);

    const a = Buffer.from(provided.toLowerCase());
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
