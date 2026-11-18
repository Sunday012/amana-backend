import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { EventPayload, QUEUES } from '../../common/events';

/**
 * Thin wrapper over the events queue. Webhooks acknowledge fast and the work
 * happens here, so processing is always safe to repeat (PRD section 7).
 */
@Injectable()
export class EventBusService {
  private readonly logger = new Logger(EventBusService.name);

  constructor(@InjectQueue(QUEUES.events) private readonly queue: Queue) {}

  async emit(payload: EventPayload): Promise<void> {
    this.logger.log(`${payload.event} agreement=${payload.agreementId}`);
    await this.queue.add(payload.event, payload, {
      removeOnComplete: 1000,
      removeOnFail: 5000,
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
    });
  }
}
