import { Injectable, OnModuleInit, OnModuleDestroy, Inject, Logger } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { IUsersService } from '../users/users.interface';

@Injectable()
export class MonitorScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MonitorScheduler.name);
  private queue: Queue;
  private intervalId: NodeJS.Timeout | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
    @Inject('IUsersService')
    private readonly usersService: IUsersService,
    @Inject('REDIS_CLIENT')
    private readonly redisConnection: Redis,
  ) {}

  onModuleInit(): void {
    this.logger.log('Starting Monitor Scheduler...');
    
    this.queue = new Queue('position-monitor', {
      connection: this.redisConnection,
    });

    const intervalSeconds = this.configService.get<number>('monitor.intervalSeconds') || 30;
    this.logger.log(`Scheduling monitor interval every ${intervalSeconds} seconds`);

    this.intervalId = setInterval(() => this.enqueueJobs(), intervalSeconds * 1000);
    this.schedulerRegistry.addInterval('position-monitor-interval', this.intervalId);
  }

  onModuleDestroy(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
  }

  async getQueueDepth(): Promise<number> {
    if (!this.queue) {
      return 0;
    }
    return this.queue.getWaitingCount();
  }

  async enqueueJobs(): Promise<void> {
    try {
      this.logger.debug('Running position monitor job enqueue cycle...');
      const activeUsers = await this.usersService.getActiveUsers();
      
      this.logger.debug(`Found ${activeUsers.length} active users to check`);

      for (const user of activeUsers) {
        const jobId = `monitor-${user.id}`;
        
        await this.queue.add(
          'monitor-user-positions',
          { userId: user.id },
          {
            jobId,
            removeOnComplete: true,
            removeOnFail: 100,
          },
        );
      }
    } catch (error: any) {
      this.logger.error(`Error in monitor enqueue cycle: ${error.message}`);
    }
  }
}
