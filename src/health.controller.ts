import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from './prisma/prisma.service';

@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  @Get('health')
  async health() {
    let database = 'down';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      database = 'up';
    } catch {
      database = 'down';
    }
    return {
      status: database === 'up' ? 'ok' : 'degraded',
      database,
      paymentMode: this.config.get('PAYMENT_MODE') ?? 'fake',
      deliveryMode: this.config.get('DELIVERY_MODE') ?? 'fake',
      aiMode: this.config.get('AI_MODE') ?? 'heuristic',
    };
  }
}
