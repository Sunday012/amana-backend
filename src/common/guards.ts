import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Missing bearer token');
    try {
      const claims = await this.jwt.verifyAsync(header.slice(7));
      (req as Request & { user: unknown }).user = {
        id: claims.sub,
        phone: claims.phone,
        isAdmin: !!claims.isAdmin,
      };
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    if (!req.user?.isAdmin) throw new ForbiddenException('Admin only');
    return true;
  }
}

/**
 * PRD section 11: every API call checks the caller is a party to that agreement.
 * Reads the agreement id from :id or :agreementId on the route.
 */
@Injectable()
export class AgreementPartyGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const user = req.user;
    if (!user) throw new UnauthorizedException();
    const agreementId: string | undefined = req.params.agreementId ?? req.params.id;
    if (!agreementId) throw new ForbiddenException('No agreement in scope');

    const agreement = await this.prisma.agreement.findUnique({
      where: { id: agreementId },
      select: { payerId: true, payeeId: true },
    });
    if (!agreement) throw new ForbiddenException('Agreement not found');
    if (user.isAdmin) return true;
    if (agreement.payerId !== user.id && agreement.payeeId !== user.id) {
      throw new ForbiddenException('You are not a party to this agreement');
    }
    return true;
  }
}

/**
 * PRD section 11: the payout endpoint is callable only by the backend,
 * never by a client or a bot.
 */
@Injectable()
export class InternalOnlyGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const provided = req.headers['x-internal-key'];
    const expected = this.config.get<string>('INTERNAL_API_KEY');
    if (!expected || provided !== expected) throw new ForbiddenException('Internal callers only');
    return true;
  }
}
