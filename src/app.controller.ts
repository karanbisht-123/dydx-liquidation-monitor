import { Controller, Get } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import Redis from 'ioredis';

@Controller('health')
export class AppController {
  constructor(
    @Inject('REDIS_CLIENT')
    private readonly redis: Redis,
  ) {}

  @Get()
  async getHealth(): Promise<{ status: string; timestamp: string; redis: string }> {
    let redisStatus = 'down';
    try {
      await this.redis.ping();
      redisStatus = 'ok';
    } catch {
      redisStatus = 'down';
    }
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      redis: redisStatus,
    };
  }
}
