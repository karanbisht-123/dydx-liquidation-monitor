import { Controller, Get } from '@nestjs/common';
import { MonitorScheduler } from './modules/monitor/monitor.scheduler';

@Controller('health')
export class AppController {
  constructor(private readonly monitorScheduler: MonitorScheduler) {}

  @Get()
  async getHealth(): Promise<{ status: string; timestamp: string; queueDepth: number }> {
    const queueDepth = await this.monitorScheduler.getQueueDepth();
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      queueDepth,
    };
  }
}
