import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { AdminGuard, JwtAuthGuard } from '../../common/guards';
import { serialize } from '../../common/serialize';
import { ZodValidationPipe } from '../../common/zod.pipe';
import { DisputesService } from '../disputes/disputes.service';

const ruleSchema = z.object({
  decision: z.enum(['RELEASE', 'REFUND']),
  reasoning: z.string().min(5).max(1000),
});

@Controller('admin')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminController {
  constructor(private readonly disputes: DisputesService) {}

  @Get('disputes')
  async open() {
    return serialize(await this.disputes.listOpen());
  }

  @Post('disputes/:id/rule')
  async rule(
    @CurrentUser() admin: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ruleSchema)) body: z.infer<typeof ruleSchema>,
  ) {
    return this.disputes.rule(id, admin.id, body.decision, body.reasoning);
  }
}
