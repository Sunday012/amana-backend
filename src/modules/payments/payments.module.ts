import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FakePagaProvider } from '../../providers/paga/fake-paga.provider';
import { PagaProvider } from '../../providers/paga/paga.provider';
import { PaymentProvider } from '../../providers/paga/paga.types';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

@Module({
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
    FakePagaProvider,
    PagaProvider,
    {
      // The fake payment switch from the PRD handoff contracts.
      provide: PaymentProvider,
      inject: [ConfigService, FakePagaProvider, PagaProvider],
      useFactory: (config: ConfigService, fake: FakePagaProvider, real: PagaProvider) =>
        config.get<string>('PAYMENT_MODE') === 'paga' ? real : fake,
    },
  ],
  exports: [PaymentsService, PaymentProvider],
})
export class PaymentsModule {}
