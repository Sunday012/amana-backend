import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { QUEUES } from '../../common/events';
import { AuditService } from './audit.service';
import { EventBusService } from './event-bus.service';
import { TransitionService } from './transition.service';

@Global()
@Module({
  imports: [BullModule.registerQueue({ name: QUEUES.events })],
  providers: [AuditService, EventBusService, TransitionService],
  exports: [AuditService, EventBusService, TransitionService, BullModule],
})
export class CoreModule {}
