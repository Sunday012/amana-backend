import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from './prisma/prisma.module';
import { AgreementsModule } from './modules/agreements/agreements.module';
import { AuthModule } from './modules/auth/auth.module';
import { BotModule } from './modules/bot/bot.module';
import { CompilerModule } from './modules/compiler/compiler.module';
import { CoreModule } from './modules/core/core.module';
import { DisputesModule } from './modules/disputes/disputes.module';
import { HealthController } from './health.controller';
import { JobsModule } from './modules/jobs/jobs.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { OutcomeModule } from './modules/outcome/outcome.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = new URL(config.get<string>('REDIS_URL') ?? 'redis://localhost:6379');
        // rediss:// means TLS, which hosted Redis (Upstash and friends) requires.
        const secure = url.protocol === 'rediss:';
        return {
          // Namespaces every BullMQ key. Without it, a Redis shared with
          // another project collides on queue names.
          prefix: config.get<string>('REDIS_PREFIX') ?? 'amana',
          connection: {
            host: url.hostname,
            port: Number(url.port || 6379),
            // Redis 6 ACLs send a username; Upstash uses "default".
            username: url.username || undefined,
            password: url.password || undefined,
            ...(secure ? { tls: { servername: url.hostname } } : {}),
            // BullMQ requires this: its workers hold blocking reads open, and
            // ioredis' default retry limit kills them mid-block.
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
          },
        };
      },
    }),
    PrismaModule,
    CoreModule,
    AuthModule,
    CompilerModule,
    OutcomeModule,
    PaymentsModule,
    AgreementsModule,
    WebhooksModule,
    DisputesModule,
    NotificationsModule,
    JobsModule,
    BotModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
