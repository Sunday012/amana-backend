import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { formatAmount } from '../../common/serialize';
import { PrismaService } from '../../prisma/prisma.service';
import { AgreementsService } from '../agreements/agreements.service';
import { AuthService } from '../auth/auth.service';
import { parseIntent, ParsedIntent, SLOT_PROMPTS } from './intent';

interface Conversation {
  slots: ParsedIntent['slots'];
  awaiting?: keyof ParsedIntent['slots'];
}

/**
 * The chat front door. It keeps no agreement state of its own beyond the
 * conversation step — every decision goes through the agreements API.
 */
@Injectable()
export class BotService {
  private readonly logger = new Logger(BotService.name);
  private readonly conversations = new Map<string, Conversation>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly agreements: AgreementsService,
    private readonly config: ConfigService,
  ) {}

  async handleMessage(rawPhone: string, message: string): Promise<{ reply: string }> {
    const phone = AuthService.normalisePhone(rawPhone);
    // Identify the user by phone and create a lightweight account on first contact.
    const user = await this.auth.findOrCreateByPhone(phone);
    const pending = this.conversations.get(phone);

    if (pending?.awaiting) return this.fillSlot(phone, user.id, pending, message);

    const parsed = parseIntent(message);
    switch (parsed.intent) {
      case 'create_order':
        this.conversations.set(phone, { slots: parsed.slots });
        return this.advance(phone, user.id);
      case 'check_status':
        return { reply: await this.statusSummary(user.id) };
      case 'confirm_delivery':
        return this.confirmLatest(user.id, 'CONFIRM');
      case 'report_problem':
        return this.confirmLatest(user.id, 'PROBLEM');
      case 'help':
      default:
        return {
          reply:
            'Amana — agree, verify, pay.\n' +
            '• "Create protected order for <item>, ₦<price>" to start a deal\n' +
            '• "status" to see your agreements\n' +
            '• Reply 1 to confirm a delivery, 2 to report a problem',
        };
    }
  }

  private async fillSlot(
    phone: string,
    userId: string,
    conversation: Conversation,
    message: string,
  ): Promise<{ reply: string }> {
    const slot = conversation.awaiting!;
    const text = message.trim();

    if (slot === 'amountMinor') {
      const major = Number(text.replace(/[₦,\s]/g, ''));
      if (!Number.isFinite(major) || major <= 0) {
        return { reply: 'I need a number for the price. For example: 180000' };
      }
      conversation.slots.amountMinor = Math.round(major * 100);
    } else if (slot === 'deliveryTerms') {
      conversation.slots.deliveryTerms = /^skip$/i.test(text) ? undefined : text.slice(0, 500);
      conversation.awaiting = undefined;
      this.conversations.set(phone, conversation);
      return this.createOrder(phone, userId, conversation);
    } else {
      conversation.slots[slot] = text.slice(0, 140) as never;
    }

    conversation.awaiting = undefined;
    this.conversations.set(phone, conversation);
    return this.advance(phone, userId);
  }

  private async advance(phone: string, userId: string): Promise<{ reply: string }> {
    const conversation = this.conversations.get(phone)!;
    const missing = SLOT_PROMPTS.find((prompt) => conversation.slots[prompt.slot] === undefined);

    if (!missing) return this.createOrder(phone, userId, conversation);

    conversation.awaiting = missing.slot;
    this.conversations.set(phone, conversation);

    // Confirm what we already understood before asking for the next field.
    const known =
      conversation.slots.item && conversation.slots.amountMinor
        ? `Got it: ${conversation.slots.item}, ${formatAmount(BigInt(conversation.slots.amountMinor))}. `
        : '';
    return { reply: `${known}${missing.question}` };
  }

  private async createOrder(
    phone: string,
    userId: string,
    conversation: Conversation,
  ): Promise<{ reply: string }> {
    const { item, amountMinor, buyerPhone, deliveryTerms } = conversation.slots;
    this.conversations.delete(phone);

    const agreement = await this.agreements.createTrade(userId, {
      title: item!,
      amount: amountMinor!,
      currency: 'NGN',
      buyerPhone: buyerPhone!,
      deliveryTerms,
      createdVia: 'WHATSAPP',
    });

    const base = this.config.get<string>('PUBLIC_WEB_URL') ?? 'http://localhost:3000';
    return {
      reply:
        `Protected order created.\n` +
        `Item: ${item}\n` +
        `Price: ${formatAmount(BigInt(amountMinor!))}\n` +
        `Buyer: ${buyerPhone}\n\n` +
        `The buyer gets this link to review and pay:\n${base}/a/${agreement.id}\n\n` +
        `Money is held by Amana until the buyer confirms delivery.`,
    };
  }

  private async statusSummary(userId: string): Promise<string> {
    const rows = await this.agreements.list(userId);
    if (rows.length === 0) return 'You have no agreements yet.';
    return rows
      .slice(0, 5)
      .map(
        (row) =>
          `• ${row.title} — ${row.status.replace(/_/g, ' ').toLowerCase()} (${formatAmount(
            row.totalAmount,
            row.currency,
          )})\n  Next: ${row.nextAction.label}`,
      )
      .join('\n');
  }

  /** "Reply 1 to confirm, 2 to report a problem" resolves to the newest open deal. */
  private async confirmLatest(
    userId: string,
    outcome: 'CONFIRM' | 'PROBLEM',
  ): Promise<{ reply: string }> {
    const agreement = await this.prisma.agreement.findFirst({
      where: {
        payerId: userId,
        status: { in: ['FUNDED', 'IN_PROGRESS', 'EVIDENCE_IN'] },
      },
      orderBy: { updatedAt: 'desc' },
    });
    if (!agreement) return { reply: 'You have no delivery waiting for confirmation.' };

    await this.agreements.confirm(agreement.id, userId, { outcome });
    return {
      reply:
        outcome === 'CONFIRM'
          ? `Thank you. Payment for "${agreement.title}" is being released to the seller.`
          : `Noted. A dispute is open on "${agreement.title}" and the payout is locked until it is reviewed.`,
    };
  }
}
