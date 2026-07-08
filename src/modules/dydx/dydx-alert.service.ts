import { Injectable, Logger, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { DydxEventsService } from './dydx-events.service';
import { DydxPosition, AlertLevel } from './dydx.types';
import {
  CRITICAL_THRESHOLD_PCT,
  WARNING_THRESHOLD_PCT,
  ALERT_DEDUP_TTL_SEC,
} from './dydx.constants';

@Injectable()
export class DydxAlertService {
  private readonly logger = new Logger(DydxAlertService.name);

  constructor(
    @Inject('REDIS_CLIENT')
    private readonly redis: Redis,
    private readonly eventsService: DydxEventsService,
  ) { }

  async checkAndEmitEvent(position: DydxPosition): Promise<void> {
    if (position.distancePct === null) return;

    const abs = Math.abs(position.distancePct);
    let level: AlertLevel | null = null;

    if (abs <= CRITICAL_THRESHOLD_PCT) {
      level = AlertLevel.CRITICAL;
    } else if (abs <= WARNING_THRESHOLD_PCT) {
      level = AlertLevel.WARNING;
    } else {
      return;
    }

    const dedupKey = `dydx:alert:${position.address}:${position.subaccountNumber}:${position.market}:${level}`;
    try {
      const exists = await this.redis.get(dedupKey);
      if (exists) return;
      await this.redis.set(dedupKey, '1', 'EX', ALERT_DEDUP_TTL_SEC);
    } catch (err: unknown) {
      this.logger.warn(`Redis dedup check failed: ${(err as Error).message}`);
    }

    await this.eventsService.emitWarning(
      position.address,
      position.subaccountNumber,
      position.market,
      position.side,
      position.liqPrice ?? 0,
      position.oraclePrice,
      position.distancePct,
      level,
    );
  }
}
