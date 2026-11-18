import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AdminGuard, AgreementPartyGuard, InternalOnlyGuard, JwtAuthGuard } from '../../common/guards';
import { EmailSender } from '../../providers/email/email.sender';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET') ?? 'dev-secret',
        signOptions: { expiresIn: (config.get<string>('JWT_EXPIRES_IN') ?? '7d') as `${number}d` },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    EmailSender,
    JwtAuthGuard,
    AdminGuard,
    AgreementPartyGuard,
    InternalOnlyGuard,
  ],
  exports: [
    AuthService,
    EmailSender,
    JwtModule,
    JwtAuthGuard,
    AdminGuard,
    AgreementPartyGuard,
    InternalOnlyGuard,
  ],
})
export class AuthModule {}
