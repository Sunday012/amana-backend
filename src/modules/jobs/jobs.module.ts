import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { OutcomeModule } from '../outcome/outcome.module';
import { PaymentsModule } from '../payments/payments.module';
import { EventsProcessor } from './events.processor';
import { ReconcilerService } from './reconciler.service';

@Module({
  imports: [PaymentsModule, NotificationsModule, OutcomeModule],
  providers: [EventsProcessor, ReconcilerService],
})
export class JobsModule {}
