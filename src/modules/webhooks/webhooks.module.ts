import { Module } from '@nestjs/common';
import { AgreementsModule } from '../agreements/agreements.module';
import { OutcomeModule } from '../outcome/outcome.module';
import { PaymentsModule } from '../payments/payments.module';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

@Module({
  imports: [PaymentsModule, OutcomeModule, AgreementsModule],
  controllers: [WebhooksController],
  providers: [WebhooksService],
  exports: [WebhooksService],
})
export class WebhooksModule {}
