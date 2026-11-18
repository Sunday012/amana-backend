import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomInt } from 'node:crypto';
import { EmailSender } from '../../providers/email/email.sender';
import { PrismaService } from '../../prisma/prisma.service';

const OTP_TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly email: EmailSender,
  ) {}

  /** Normalises Nigerian numbers to E.164 so chat and web resolve to one user. */
  static normalisePhone(raw: string): string {
    const digits = raw.replace(/[^\d+]/g, '');
    if (digits.startsWith('+')) return digits;
    if (digits.startsWith('234')) return `+${digits}`;
    if (digits.startsWith('0')) return `+234${digits.slice(1)}`;
    return `+${digits}`;
  }

  /**
   * Creates the user on first contact (bots do this too). The phone number is
   * the identity.
   *
   * Note what this deliberately does NOT take: an email. A delivery address
   * can only be set by someone already signed in (see setEmail), because a
   * caller-supplied address would let anyone redirect another user's login
   * code to themselves.
   */
  async findOrCreateByPhone(
    rawPhone: string,
    name?: string,
  ): Promise<{ id: string; phone: string; email: string | null }> {
    const phone = AuthService.normalisePhone(rawPhone);
    const existing = await this.prisma.user.findUnique({ where: { phone } });
    if (existing) {
      const updated =
        name && !existing.name
          ? await this.prisma.user.update({ where: { id: existing.id }, data: { name } })
          : existing;
      return { id: updated.id, phone: updated.phone, email: updated.email };
    }
    const created = await this.prisma.user.create({ data: { phone, name } });
    return { id: created.id, phone: created.phone, email: created.email };
  }

  /**
   * Sets where this user's login codes go. Only callable with a valid token,
   * which can only be obtained by passing an OTP — so an address can only be
   * attached by someone who already controls the account.
   */
  async setEmail(userId: string, email: string): Promise<{ email: string }> {
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { email },
    });
    this.logger.log(`Delivery address updated for ${updated.phone}`);
    return { email: updated.email! };
  }

  async requestOtp(
    rawPhone: string,
  ): Promise<{ sent: boolean; channel: 'email' | 'log'; debugCode?: string }> {
    const user = await this.findOrCreateByPhone(rawPhone);
    const code = randomInt(100000, 999999).toString();
    await this.prisma.otpCode.create({
      data: {
        userId: user.id,
        codeHash: AuthService.hash(code),
        expiresAt: new Date(Date.now() + OTP_TTL_MINUTES * 60_000),
      },
    });

    // Only ever the address stored on the account.
    const destination = user.email;
    const delivered = destination
      ? await this.email.send({
          to: destination,
          subject: `${code} is your Amana code`,
          text:
            `Your Amana login code is ${code}.\n\n` +
            `It expires in ${OTP_TTL_MINUTES} minutes. If you did not ask to sign in, ignore this email.`,
        })
      : false;

    if (delivered) return { sent: true, channel: 'email' };

    // Nothing could deliver it. Log it so development still works, and only
    // return it in the response when OTP_DEBUG is explicitly on — that flag
    // lets anyone sign in as anyone, so it must never be set in production.
    this.logger.warn(`OTP for ${user.phone}: ${code}`);
    return {
      sent: false,
      channel: 'log',
      ...(this.config.get('OTP_DEBUG') === 'true' ? { debugCode: code } : {}),
    };
  }

  async verifyOtp(rawPhone: string, code: string): Promise<{ token: string; user: unknown }> {
    const phone = AuthService.normalisePhone(rawPhone);
    const user = await this.prisma.user.findUnique({ where: { phone } });
    if (!user) throw new UnauthorizedException('Unknown phone number');

    const otp = await this.prisma.otpCode.findFirst({
      where: { userId: user.id, consumed: false, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!otp) throw new UnauthorizedException('No active code; request a new one');
    if (otp.attempts >= MAX_ATTEMPTS) throw new BadRequestException('Too many attempts');

    if (otp.codeHash !== AuthService.hash(code)) {
      await this.prisma.otpCode.update({
        where: { id: otp.id },
        data: { attempts: { increment: 1 } },
      });
      throw new UnauthorizedException('Incorrect code');
    }

    await this.prisma.otpCode.update({ where: { id: otp.id }, data: { consumed: true } });
    const verified = await this.prisma.user.update({
      where: { id: user.id },
      data: { verifiedAt: user.verifiedAt ?? new Date() },
    });

    return { token: await this.sign(verified), user: this.publicUser(verified) };
  }

  async sign(user: { id: string; phone: string; isAdmin: boolean }): Promise<string> {
    return this.jwt.signAsync({ sub: user.id, phone: user.phone, isAdmin: user.isAdmin });
  }

  publicUser(user: { id: string; phone: string; name: string | null; isAdmin: boolean }) {
    return { id: user.id, phone: user.phone, name: user.name, isAdmin: user.isAdmin };
  }

  private static hash(code: string): string {
    return createHash('sha256').update(code).digest('hex');
  }
}
