import { Body, Controller, Get, Patch, Post, UseGuards, UsePipes } from '@nestjs/common';
import { z } from 'zod';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards';
import { ZodValidationPipe } from '../../common/zod.pipe';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthService } from './auth.service';

const requestOtpSchema = z.object({
  phone: z.string().min(7),
  /** Used only when this phone number has no account yet. */
  email: z.string().email().optional(),
});
const setEmailSchema = z.object({ email: z.string().email() });
const verifyOtpSchema = z.object({ phone: z.string().min(7), code: z.string().length(6) });

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('otp/request')
  @UsePipes(new ZodValidationPipe(requestOtpSchema))
  requestOtp(@Body() body: z.infer<typeof requestOtpSchema>) {
    return this.auth.requestOtp(body.phone, body.email);
  }

  @Post('otp/verify')
  @UsePipes(new ZodValidationPipe(verifyOtpSchema))
  verifyOtp(@Body() body: z.infer<typeof verifyOtpSchema>) {
    return this.auth.verifyOtp(body.phone, body.code);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@CurrentUser() user: AuthUser) {
    const row = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    return { ...this.auth.publicUser(row), email: row.email };
  }

  /**
   * Choose where this account's login codes are delivered. Requires a token,
   * so only someone who already passed an OTP can point them somewhere new.
   */
  @Patch('me/email')
  @UseGuards(JwtAuthGuard)
  setEmail(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(setEmailSchema)) body: z.infer<typeof setEmailSchema>,
  ) {
    return this.auth.setEmail(user.id, body.email);
  }
}
