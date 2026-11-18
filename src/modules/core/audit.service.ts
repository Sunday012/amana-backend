import { Injectable } from '@nestjs/common';
import { AgreementStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export interface AuditEntry {
  agreementId: string;
  actor: string;
  action: string;
  fromStatus?: AgreementStatus | null;
  toStatus?: AgreementStatus | null;
  evidenceRef?: string | null;
  meta?: Record<string, unknown>;
}

/** Append-only log. Nothing in the codebase updates or deletes these rows. */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry, tx?: Prisma.TransactionClient): Promise<void> {
    const client = tx ?? this.prisma;
    await client.auditLog.create({
      data: {
        agreementId: entry.agreementId,
        actor: entry.actor,
        action: entry.action,
        fromStatus: entry.fromStatus ?? null,
        toStatus: entry.toStatus ?? null,
        evidenceRef: entry.evidenceRef ?? null,
        metaJson: (entry.meta ?? {}) as Prisma.InputJsonValue,
      },
    });
  }

  list(agreementId: string) {
    return this.prisma.auditLog.findMany({
      where: { agreementId },
      orderBy: { createdAt: 'asc' },
    });
  }
}
