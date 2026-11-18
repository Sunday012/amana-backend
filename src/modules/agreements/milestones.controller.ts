import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards';
import { serialize } from '../../common/serialize';
import { ZodValidationPipe } from '../../common/zod.pipe';
import { milestoneEvidenceSchema } from './agreements.dto';
import { MilestonesService } from './milestones.service';

const rejectSchema = z.object({ reason: z.string().min(3).max(500) });

@Controller('milestones')
@UseGuards(JwtAuthGuard)
export class MilestonesController {
  constructor(private readonly milestones: MilestonesService) {}

  @Post(':id/evidence')
  async evidence(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(milestoneEvidenceSchema))
    body: z.infer<typeof milestoneEvidenceSchema>,
  ) {
    return serialize(await this.milestones.submitEvidence(id, user.id, body));
  }

  @Post(':id/approve')
  async approve(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return serialize(await this.milestones.approve(id, user.id));
  }

  @Post(':id/reject')
  async reject(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(rejectSchema)) body: z.infer<typeof rejectSchema>,
  ) {
    return serialize(await this.milestones.reject(id, user.id, body.reason));
  }
}
