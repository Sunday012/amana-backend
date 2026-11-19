import { Body, Controller, Get, Param, Post, Put, UseGuards, UsePipes } from '@nestjs/common';
import { z } from 'zod';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { AgreementPartyGuard, InternalOnlyGuard, JwtAuthGuard } from '../../common/guards';
import { serialize } from '../../common/serialize';
import { ZodValidationPipe } from '../../common/zod.pipe';
import { PaymentsService } from './payments.service';

const collectionSchema = z.object({ agreementId: z.string().uuid() });
const payoutAccountSchema = z.object({
  bankUuid: z.string().min(1),
  accountNumber: z.string().regex(/^\d{10}$/, 'A Nigerian account number is 10 digits'),
});
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

  /** Banks a payout can be sent to. Cheap, and only useful while choosing. */
  @Get('payouts/banks')
  @UseGuards(JwtAuthGuard)
  banks() {
    return this.payments.listBanks();
  }

  /** Whether the signed-in user can be paid yet. */
  @Get('payouts/account')
  @UseGuards(JwtAuthGuard)
  payoutAccount(@CurrentUser() user: AuthUser) {
    return this.payments.payoutReadiness(user.id);
  }

  /**
   * Confirms the account with the bank and saves it. The response carries the
   * name the bank holds, which the UI must show before anyone relies on it.
   */
  @Put('payouts/account')
  @UseGuards(JwtAuthGuard)
  setPayoutAccount(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(payoutAccountSchema)) body: z.infer<typeof payoutAccountSchema>,
  ) {
    return this.payments.setPayoutAccount(user.id, body.bankUuid, body.accountNumber);
  }

  /** Backend only — never a client or a bot (PRD section 11). */
  @Post('payouts')
  @UseGuards(InternalOnlyGuard)
  @UsePipes(new ZodValidationPipe(payoutSchema))
  payout(@Body() body: z.infer<typeof payoutSchema>) {
    return this.payments.payout({ ...body, actor: 'internal' });
  }
}
