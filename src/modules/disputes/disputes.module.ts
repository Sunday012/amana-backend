import { Module } from '@nestjs/common';
import { AdminController } from '../admin/admin.controller';
import { PaymentsModule } from '../payments/payments.module';
import { DisputesService } from './disputes.service';

@Module({
  imports: [PaymentsModule],
  controllers: [AdminController],
  providers: [DisputesService],
  exports: [DisputesService],
})
export class DisputesModule {}
