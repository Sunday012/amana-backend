import { ConflictException, Injectable } from '@nestjs/common';
import { Agreement, AgreementStatus, Prisma } from '@prisma/client';
import { assertTransition, IllegalTransitionError } from '../../common/state-machine';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from './audit.service';

export interface TransitionOptions {
  actor: string;
  action: string;
  evidenceRef?: string;
  meta?: Record<string, unknown>;
  data?: Prisma.AgreementUpdateInput;
}

/**
 * The single place an agreement's status changes. Every call validates the
 * transition and writes an audit row in the same transaction.
 */
@Injectable()
export class TransitionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async to(
    agreementId: string,
    next: AgreementStatus,
    options: TransitionOptions,
    tx?: Prisma.TransactionClient,
  ): Promise<Agreement> {
    const run = async (client: Prisma.TransactionClient): Promise<Agreement> => {
      const current = await client.agreement.findUniqueOrThrow({ where: { id: agreementId } });
      try {
        assertTransition(current.status, next);
      } catch (error) {
        if (error instanceof IllegalTransitionError) throw new ConflictException(error.message);
        throw error;
      }

      const updated = await client.agreement.update({
        where: { id: agreementId },
        data: { ...options.data, status: next },
      });

      await this.audit.record(
        {
          agreementId,
          actor: options.actor,
          action: options.action,
          fromStatus: current.status,
          toStatus: next,
          evidenceRef: options.evidenceRef,
          meta: options.meta,
        },
        client,
      );
      return updated;
    };

    return tx ? run(tx) : this.prisma.$transaction(run);
  }
}
