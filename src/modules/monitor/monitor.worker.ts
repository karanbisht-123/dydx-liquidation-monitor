import { Injectable, OnModuleInit, OnModuleDestroy, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker, Job } from 'bullmq';
import Redis from 'ioredis';
import { Decimal } from 'decimal.js';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { IUsersService } from '../users/users.interface';
import { IPositionsService } from '../positions/positions.interface';
import { IDydxService } from '../dydx/dydx.interface';
import { IRiskService } from '../risk/risk.interface';
import { INotificationsService } from '../notifications/notifications.interface';

@Injectable()
export class MonitorWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MonitorWorker.name);
  private worker: Worker;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    @Inject('REDIS_CLIENT')
    private readonly redisConnection: Redis,
    @Inject('IUsersService')
    private readonly usersService: IUsersService,
    @Inject('IPositionsService')
    private readonly positionsService: IPositionsService,
    @Inject('IDydxService')
    private readonly dydxService: IDydxService,
    @Inject('IRiskService')
    private readonly riskService: IRiskService,
    @Inject('INotificationsService')
    private readonly notificationsService: INotificationsService,
  ) { }

  onModuleInit(): void {
    const concurrency = this.configService.get<number>('monitor.bullConcurrency') || 10;
    this.logger.log(`Starting Monitor Worker with concurrency: ${concurrency}`);

    this.worker = new Worker(
      'position-monitor',
      async (job: Job) => {
        try {
          await this.processJob(job);
        } catch (error: any) {
          this.logger.error(`Error processing job ${job.id} for user ${job.data?.userId}: ${error.message}`);
          // Do not rethrow so the job is marked as completed or handled by onFailed
        }
      },
      {
        connection: this.redisConnection,
        concurrency,
      },
    );

    this.worker.on('failed', (job: Job | undefined, err: Error) => {
      if (job) {
        this.logger.error(`Job ${job.id} failed for user ${job.data?.userId}: ${err.message}`);
      } else {
        this.logger.error(`Worker job failed: ${err.message}`);
      }
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
      this.logger.log('Monitor Worker closed successfully');
    }
  }

  private async processJob(job: Job): Promise<void> {
    const { userId } = job.data;
    this.logger.debug(`Worker processing job ${job.id} for user ID: ${userId}`);

    const user = await this.usersService.getUserById(userId);

    console.log(user, 'user')
    if (!user) {
      this.logger.error(`User with ID ${userId} not found in DB. Skipping job.`);
      return;
    }

    // Call dYdX indexer to get current live positions
    const apiPositions = await this.dydxService.getPositions(user.walletAddress);

    // Get current database OPEN positions to check if any have been closed
    const dbActivePositions = await this.positionsService.getUserActivePositions(userId);
    const dbActivePositionIds = dbActivePositions.map((p) => p.positionId);

    const apiPositionIds = new Set<string>();

    for (const apiPos of apiPositions) {
      apiPositionIds.add(apiPos.positionId);

      // Perform risk calculations using decimal.js
      const liqPrice = this.riskService.calculateLiquidationPrice({
        size: apiPos.size,
        oraclePrice: apiPos.oraclePrice,
        maintenanceMarginFraction: apiPos.maintenanceMarginFraction,
        entryPrice: apiPos.entryPrice,
        margin: apiPos.margin,
        side: apiPos.side,
      });

      const distancePct = this.riskService.calculateDistancePct(apiPos.oraclePrice, liqPrice);

      // Upsert the position into DB
      await this.positionsService.upsertPosition({
        userId,
        positionId: apiPos.positionId,
        marketId: apiPos.marketId,
        side: apiPos.side,
        size: apiPos.size,
        entryPrice: apiPos.entryPrice,
        liquidationPrice: liqPrice,
        oraclePrice: apiPos.oraclePrice,
        margin: apiPos.margin,
      });

      // Assess risk level based on distance
      const alertType = this.riskService.assessRisk(distancePct);

      if (alertType) {
        // Cooldown TTL: WARNING=600s, DANGER=300s, CRITICAL=120s
        let ttlSeconds = 600;
        if (alertType === 'DANGER') {
          ttlSeconds = 300;
        } else if (alertType === 'CRITICAL') {
          ttlSeconds = 120;
        }

        const cooldownKey = `cooldown:${userId}:${apiPos.positionId}:${alertType}`;

        // Use Redis SET NX to check cooldown status
        const setResult = await this.redisConnection.set(cooldownKey, '1', 'EX', ttlSeconds, 'NX');

        if (setResult === 'OK') {
          this.logger.warn(
            `LIQUIDATION RISK DETECTED: User=${user.walletAddress}, Market=${apiPos.marketId}, ` +
            `Side=${apiPos.side}, Risk=${alertType}, Distance=${distancePct.toFixed(2)}%`,
          );

          if (user.fcmToken) {
            await this.notificationsService.sendLiquidationAlert(user.fcmToken, {
              userId,
              positionId: apiPos.positionId,
              marketId: apiPos.marketId,
              side: apiPos.side,
              distancePct: distancePct.toFixed(2),
              liquidationPrice: liqPrice.toFixed(4),
              oraclePrice: apiPos.oraclePrice.toFixed(4),
              alertType,
              marginType: apiPos.marginType,
            });
          }

          // Create an AlertLog record
          await this.prisma.alertLog.create({
            data: {
              userId,
              positionId: apiPos.positionId,
              alertType,
              distancePct: new Prisma.Decimal(distancePct.toString()),
              oraclePrice: new Prisma.Decimal(apiPos.oraclePrice.toString()),
              liqPrice: new Prisma.Decimal(liqPrice.toString()),
            },
          });
        } else {
          this.logger.debug(
            `Cooldown active for ${cooldownKey}. Notification suppressed.`,
          );
        }
      }
    }

    // Closed position cleanup
    const closedPositionIds = dbActivePositionIds.filter((id) => !apiPositionIds.has(id));
    for (const closedId of closedPositionIds) {
      await this.positionsService.markClosed(userId, closedId);
      
      // Clean up Redis cooldown keys for this closed position immediately
      try {
        await this.redisConnection.del(
          `cooldown:${userId}:${closedId}:WARNING`,
          `cooldown:${userId}:${closedId}:DANGER`,
          `cooldown:${userId}:${closedId}:CRITICAL`,
        );
      } catch (redisErr: any) {
        this.logger.warn(
          `Failed to delete Redis cooldown keys for closed position ${closedId}: ${redisErr.message}`,
        );
      }
    }
  }
}
