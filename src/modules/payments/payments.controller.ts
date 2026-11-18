import { Body, Controller, Get, Param, Post, UseGuards, UsePipes } from '@nestjs/common';
import { z } from 'zod';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { AgreementPartyGuard, InternalOnlyGuard, JwtAuthGuard } from '../../common/guards';
import { serialize } from '../../common/serialize';
import { ZodValidationPipe } from '../../common/zod.pipe';
import { PaymentsService } from './payments.service';

const collectionSchema = z.object({ agreementId: z.string().uuid() });
// No amount or recipient here on purpose: both are read from the agreement.
const payoutSchema = z.object({
  agreementId: z.string().uuid(),
  milestoneId: z.string().uuid().optional(),
});

@Controller()
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('payments/collections')
  @UseGuards(JwtAuthGuard)
  @UsePipes(new ZodValidationPipe(collectionSchema))
  createCollection(@Body() body: z.infer<typeof collectionSchema>) {
    return this.payments.createCollection(body.agreementId);
  }

  @Get('payments/:agreementId')
  @UseGuards(JwtAuthGuard, AgreementPartyGuard)
  async status(@Param('agreementId') agreementId: string) {
    return serialize(await this.payments.statusFor(agreementId));
  }

  /** Backend only — never a client or a bot (PRD section 11). */
  @Post('payouts')
  @UseGuards(InternalOnlyGuard)
  @UsePipes(new ZodValidationPipe(payoutSchema))
  payout(@Body() body: z.infer<typeof payoutSchema>) {
    return this.payments.payout({ ...body, actor: 'internal' });
  }
}
