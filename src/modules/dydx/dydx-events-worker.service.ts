import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Inject,
} from '@nestjs/common';
import Redis from 'ioredis';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { INotificationsService } from '../notifications/notifications.interface';
import {
  EVENT_STREAM_KEY,
  EVENT_CONSUMER_GROUP,
  EVENT_CONSUMER_NAME,
  ALERT_DEDUP_TTL_SEC,
} from './dydx.constants';
import { DydxEvent, AlertLevel } from './dydx.types';

/**
 * Consumes events from the Redis Stream (dydx:events) and handles:
 *   1. Push notifications (FCM) for liquidations and warnings
 *   2. Alert log persistence to the database (async, not on hot path)
 *   3. Deduplication of warnings
 *
 * Runs as an independent consumer in a consumer group, meaning it can be
 * scaled horizontally (multiple consumers sharing the load).
 */
@Injectable()
export class DydxEventsWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DydxEventsWorkerService.name);
  private running = false;
  private abortController: AbortController | null = null;

  constructor(
    @Inject('REDIS_CLIENT')
    private readonly redis: Redis,
    private readonly prisma: PrismaService,
    @Inject('INotificationsService')
    private readonly notificationsService: INotificationsService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Ensure the consumer group exists (idempotent)
    try {
      await this.redis.xgroup(
        'CREATE',
        EVENT_STREAM_KEY,
        EVENT_CONSUMER_GROUP,
        '0',
        'MKSTREAM',
      );
      this.logger.log(`Created consumer group "${EVENT_CONSUMER_GROUP}"`);
    } catch (err: unknown) {
      const msg = (err as Error).message ?? '';
      if (msg.includes('BUSYGROUP')) {
        this.logger.log(`Consumer group "${EVENT_CONSUMER_GROUP}" already exists`);
      } else {
        this.logger.error(`Failed to create consumer group: ${msg}`);
      }
    }

    this.running = true;
    this.abortController = new AbortController();
    void this.consumeLoop();
  }

  onModuleDestroy(): void {
    this.running = false;
    this.abortController?.abort();
  }

  /**
   * Main consumption loop. Blocks on XREADGROUP until new events arrive,
   * then processes them and ACKs each message.
   */
  private async consumeLoop(): Promise<void> {
    this.logger.log(`Event worker "${EVENT_CONSUMER_NAME}" started, consuming from "${EVENT_STREAM_KEY}"`);

    while (this.running) {
      try {
        const results = await this.redis.xreadgroup(
          'GROUP',
          EVENT_CONSUMER_GROUP,
          EVENT_CONSUMER_NAME,
          'COUNT',
          '100',
          'BLOCK',
          '5000',
          'STREAMS',
          EVENT_STREAM_KEY,
          '>',
        );

        if (!results || results.length === 0) continue;

        // results[0] = [streamName, [[messageId, fields], ...]]
        const stream = results[0] as unknown as [string, [string, Record<string, string>][]];
        const messages = stream[1];

        for (const [messageId, fields] of messages) {
          try {
            const event = this.parseEvent(fields);
            await this.handleEvent(event);
            await this.redis.xack(EVENT_STREAM_KEY, EVENT_CONSUMER_GROUP, messageId);
          } catch (err: unknown) {
            this.logger.error(
              `Failed to process event ${messageId}: ${(err as Error).message}`,
            );
            // Don't ACK — it will be retried on next consumer start
          }
        }
      } catch (err: unknown) {
        if (!this.running) break;
        this.logger.error(`consumeLoop error: ${(err as Error).message}`);
        // Brief back-off before retrying
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    this.logger.log('Event worker stopped');
  }

  /**
   * Parse a Redis Stream message fields object into a DydxEvent.
   */
  private parseEvent(fields: any): DydxEvent {
    const obj: Record<string, string> = {};
    if (Array.isArray(fields)) {
      for (let i = 0; i < fields.length; i += 2) {
        obj[fields[i]] = fields[i + 1];
      }
    } else {
      Object.assign(obj, fields);
    }
    const alertLevelVal = obj.alertLevel || '';
    return {
      type: obj.type as DydxEvent['type'],
      address: obj.address,
      subaccountNumber: parseInt(obj.subaccountNumber, 10) || 0,
      marketId: obj.marketId,
      side: obj.side as 'LONG' | 'SHORT',
      liqPrice: obj.liqPrice ? parseFloat(obj.liqPrice) : null,
      oraclePrice: parseFloat(obj.oraclePrice) || 0,
      distancePct: obj.distancePct ? parseFloat(obj.distancePct) : null,
      alertLevel: alertLevelVal ? (alertLevelVal as AlertLevel) : null,
      equity: obj.equity ? parseFloat(obj.equity) : null,
      timestamp: parseInt(obj.timestamp, 10) || Date.now(),
    };
  }

  /**
   * Route events to appropriate handlers.
   */
  private async handleEvent(event: DydxEvent): Promise<void> {
    switch (event.type) {
      case 'liquidation':
        await this.handleLiquidation(event);
        break;
      case 'warning':
        await this.handleWarning(event);
        break;
      case 'position_opened':
      case 'position_closed':
        // These are informational — no notification needed, just log
        this.logger.debug(
          `Event: ${event.type} ${event.address} sub#${event.subaccountNumber} ${event.marketId}`,
        );
        break;
      default:
        this.logger.warn(`Unknown event type: ${event.type}`);
    }
  }

  /**
   * Handle a liquidation event — send push notification and persist log.
   */
  private async handleLiquidation(event: DydxEvent): Promise<void> {
    this.logger.warn(
      `🚨 LIQUIDATION: ${event.address} sub#${event.subaccountNumber} ` +
      `${event.marketId} ${event.side} @ liq=${event.liqPrice?.toFixed(2)} oracle=${event.oraclePrice.toFixed(2)}`,
    );

    // 1. Try to send push notification
    try {
      const fcmToken = await this.getFcmToken(event.address);
      if (fcmToken) {
        await this.notificationsService.sendLiquidationAlert(fcmToken, {
          userId: event.address,
          positionId: `${event.subaccountNumber}-${event.marketId}`,
          marketId: event.marketId,
          side: event.side,
          distancePct: '0.00',
          liquidationPrice: event.liqPrice?.toFixed(2) ?? '?',
          oraclePrice: event.oraclePrice.toFixed(2),
          alertType: 'CRITICAL',
          marginType: event.subaccountNumber >= 128 ? 'ISOLATED' : 'CROSS',
        });
      }
    } catch (err: unknown) {
      this.logger.error(`Push notification failed: ${(err as Error).message}`);
    }

    // 2. Persist alert log (async, not blocking)
    void this.persistAlertLog(event, 'CRITICAL');
  }

  /**
   * Handle a warning event — dedup, then notify and persist.
   */
  private async handleWarning(event: DydxEvent): Promise<void> {
    if (!event.alertLevel || event.distancePct === null) return;

    const level = event.alertLevel;

    // Dedup: skip if we already sent this warning recently
    const dedupKey = `dydx:alert:${event.address}:${event.subaccountNumber}:${event.marketId}:${level}`;
    try {
      const exists = await this.redis.get(dedupKey);
      if (exists) return;
      await this.redis.set(dedupKey, '1', 'EX', ALERT_DEDUP_TTL_SEC);
    } catch (err: unknown) {
      this.logger.warn(`Dedup check failed: ${(err as Error).message}`);
    }

    this.logger.warn(
      `⚠️ WARNING [${level}]: ${event.address} sub#${event.subaccountNumber} ` +
      `${event.marketId} ${event.side} dist=${event.distancePct.toFixed(2)}% ` +
      `liq=${event.liqPrice?.toFixed(2)} oracle=${event.oraclePrice.toFixed(2)}`,
    );

    // 1. Send push notification
    try {
      const fcmToken = await this.getFcmToken(event.address);
      if (fcmToken) {
        await this.notificationsService.sendLiquidationAlert(fcmToken, {
          userId: event.address,
          positionId: `${event.subaccountNumber}-${event.marketId}`,
          marketId: event.marketId,
          side: event.side,
          distancePct: Math.abs(event.distancePct).toFixed(2),
          liquidationPrice: event.liqPrice?.toFixed(2) ?? '?',
          oraclePrice: event.oraclePrice.toFixed(2),
          alertType: level,
          marginType: event.subaccountNumber >= 128 ? 'ISOLATED' : 'CROSS',
        });
      }
    } catch (err: unknown) {
      this.logger.error(`Push notification failed: ${(err as Error).message}`);
    }

    // 2. Persist alert log (async)
    void this.persistAlertLog(event, level);
  }

  /**
   * Look up FCM token for a wallet address.
   */
  private async getFcmToken(address: string): Promise<string | null> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { walletAddress: address },
        select: { fcmToken: true },
      });
      return user?.fcmToken ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Persist an alert log entry to the database. Runs asynchronously.
   */
  private async persistAlertLog(event: DydxEvent, alertType: string): Promise<void> {
    try {
      // 1. Try the Prisma AlertLog model
      const user = await this.prisma.user.findUnique({
        where: { walletAddress: event.address },
        select: { id: true },
      });

      if (user) {
        const positionId = `${event.subaccountNumber}-${event.marketId}`;
        try {
          await this.prisma.alertLog.create({
            data: {
              userId: user.id,
              positionId,
              alertType: alertType as any,
              distancePct: event.distancePct !== null
                ? new Prisma.Decimal(event.distancePct.toFixed(4))
                : new Prisma.Decimal(0),
              oraclePrice: new Prisma.Decimal(event.oraclePrice.toFixed(10)),
              liqPrice: event.liqPrice !== null
                ? new Prisma.Decimal(event.liqPrice.toFixed(10))
                : new Prisma.Decimal(0),
            },
          });
        } catch (prismaErr: unknown) {
          // Position may not exist in Prisma Position table (it's in raw SQL snapshot)
          this.logger.debug(`Prisma alertLog create skipped: ${(prismaErr as Error).message}`);
        }
      }

      // 2. Also write to raw SQL alert_log table (keeps compatibility with existing queries)
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO alert_log
           (address, subaccount_number, market, level, liq_price, oracle_price, distance_pct, margin_type)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        event.address,
        event.subaccountNumber,
        event.marketId,
        alertType,
        event.liqPrice,
        event.oraclePrice,
        event.distancePct,
        event.subaccountNumber >= 128 ? 'ISOLATED' : 'CROSS',
      );
    } catch (err: unknown) {
      this.logger.error(`persistAlertLog failed: ${(err as Error).message}`);
    }
  }
}
