import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { EVENTS, EventPayload, QUEUES } from '../../common/events';
import { NotificationsService } from '../notifications/notifications.service';
import { PaymentsService } from '../payments/payments.service';

/**
 * The single consumer of the internal event queue: the bot's notifications and
 * the payout trigger. Everything here is safe to repeat — the payout guard and
 * the idempotency key make a duplicate delivery harmless.
 */
@Processor(QUEUES.events)
export class EventsProcessor extends WorkerHost {
  private readonly logger = new Logger(EventsProcessor.name);

  constructor(
    private readonly notifications: NotificationsService,
    private readonly payments: PaymentsService,
  ) {
    super();
  }

  async process(job: Job<EventPayload>): Promise<void> {
    const payload = job.data;

    if (payload.event === EVENTS.agreementReleasable || payload.event === EVENTS.milestoneReleasable) {
      try {
        await this.payments.payout({
          agreementId: payload.agreementId,
          milestoneId: payload.milestoneId,
          actor: 'system',
        });
      } catch (error) {
        // A refused payout is a decision, not a job failure: log and move on.
        this.logger.warn(`Payout not run for ${payload.agreementId}: ${(error as Error).message}`);
      }
    }

    await this.notifications.notify(payload);
  }
}
