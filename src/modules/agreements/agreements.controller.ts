import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AgreementStatus } from '@prisma/client';
import { z } from 'zod';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { AgreementPartyGuard, JwtAuthGuard } from '../../common/guards';
import { serialize } from '../../common/serialize';
import { ZodValidationPipe } from '../../common/zod.pipe';
import { CompilerService } from '../compiler/compiler.service';
import { MilestonesService } from './milestones.service';
import {
  compileSchema,
  confirmSchema,
  createMilestoneAgreementSchema,
  createPurchaseSchema,
  createTradeSchema,
  deliverySchema,
  disputeSchema,
  patchTermsSchema,
} from './agreements.dto';
import { AgreementsService } from './agreements.service';

@Controller('agreements')
@UseGuards(JwtAuthGuard)
export class AgreementsController {
  constructor(
    private readonly agreements: AgreementsService,
    private readonly compiler: CompilerService,
    private readonly milestones: MilestonesService,
  ) {}

  /** Create a TRADE agreement (seller). Bot and web both call this. */
  @Post()
  async createTrade(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createTradeSchema)) body: z.infer<typeof createTradeSchema>,
  ) {
    return serialize(await this.agreements.createTrade(user.id, body));
  }

  /** Create a TRADE agreement from a listing (buyer). Amana Plug calls this. */
  @Post('purchases')
  async createPurchase(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createPurchaseSchema)) body: z.infer<typeof createPurchaseSchema>,
  ) {
    return serialize(await this.agreements.createPurchase(user.id, body));
  }

  /** Create a MILESTONE agreement, typically from compiled terms. */
  @Post('milestone')
  async createMilestone(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createMilestoneAgreementSchema))
    body: z.infer<typeof createMilestoneAgreementSchema>,
  ) {
    return serialize(await this.agreements.createMilestoneAgreement(user.id, body));
  }

  /** AI proposes milestone terms from plain text. Nothing is bound yet. */
  @Post('compile')
  async compile(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(compileSchema)) body: z.infer<typeof compileSchema>,
  ) {
    return this.compiler.compile(body);
  }

  @Get()
  async list(@CurrentUser() user: AuthUser, @Query('status') status?: AgreementStatus) {
    return serialize(await this.agreements.list(user.id, status));
  }

  @Get(':id')
  @UseGuards(AgreementPartyGuard)
  async get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return serialize(await this.agreements.get(id, user.id));
  }

  @Get(':id/timeline')
  @UseGuards(AgreementPartyGuard)
  async timeline(@Param('id') id: string) {
    return serialize(await this.agreements.timeline(id));
  }

  @Post(':id/approve')
  @UseGuards(AgreementPartyGuard)
  async approve(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return serialize(await this.agreements.approve(id, user.id));
  }

  @Patch(':id/terms')
  @UseGuards(AgreementPartyGuard)
  async patchTerms(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(patchTermsSchema)) body: z.infer<typeof patchTermsSchema>,
  ) {
    return serialize(await this.agreements.patchTerms(id, user.id, body));
  }

  @Post(':id/delivery')
  @UseGuards(AgreementPartyGuard)
  async delivery(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(deliverySchema)) body: z.infer<typeof deliverySchema>,
  ) {
    return serialize(await this.agreements.startDelivery(id, user.id, body));
  }

  @Post(':id/confirm')
  @UseGuards(AgreementPartyGuard)
  async confirm(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(confirmSchema)) body: z.infer<typeof confirmSchema>,
  ) {
    return serialize(await this.agreements.confirm(id, user.id, body));
  }

  @Post(':id/dispute')
  @UseGuards(AgreementPartyGuard)
  async dispute(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(disputeSchema)) body: z.infer<typeof disputeSchema>,
  ) {
    return serialize(await this.agreements.openDispute(id, user.id, body));
  }
}
