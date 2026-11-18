import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChowdeckProvider, FakeChowdeckProvider } from '../../providers/chowdeck/chowdeck.provider';
import { DeliveryProvider } from '../../providers/chowdeck/chowdeck.types';
import { CompilerModule } from '../compiler/compiler.module';
import { OutcomeModule } from '../outcome/outcome.module';
import { PaymentsModule } from '../payments/payments.module';
import { AgreementsController } from './agreements.controller';
import { AgreementsService } from './agreements.service';
import { MilestonesController } from './milestones.controller';
import { MilestonesService } from './milestones.service';

@Module({
  imports: [OutcomeModule, PaymentsModule, CompilerModule],
  controllers: [AgreementsController, MilestonesController],
  providers: [
    AgreementsService,
    MilestonesService,
    FakeChowdeckProvider,
    ChowdeckProvider,
    {
      provide: DeliveryProvider,
      inject: [ConfigService, FakeChowdeckProvider, ChowdeckProvider],
      useFactory: (config: ConfigService, fake: FakeChowdeckProvider, real: ChowdeckProvider) =>
        config.get<string>('DELIVERY_MODE') === 'chowdeck' ? real : fake,
    },
  ],
  exports: [AgreementsService, MilestonesService, DeliveryProvider],
})
export class AgreementsModule {}
