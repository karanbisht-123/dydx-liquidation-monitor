import { Injectable, Logger, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { INotificationsService } from '../notifications/notifications.interface';
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
    @Inject('INotificationsService')
    private readonly notificationsService: INotificationsService,
  ) {}

  async checkAndAlert(position: DydxPosition, fcmToken: string): Promise<void> {
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
    } catch (err: unknown) {
      this.logger.warn(`Redis dedup check failed: ${(err as Error).message}`);
    }

    const payload = this.buildPayload(position, level);

    try {
      await this.notificationsService.sendLiquidationAlert(fcmToken, payload);

      await this.redis.set(dedupKey, '1', 'EX', ALERT_DEDUP_TTL_SEC);
    } catch (err: unknown) {
      this.logger.error(
        `Alert send failed for ${position.market} [${level}]: ${(err as Error).message}`,
      );
    }
  }

  private buildPayload(
    position: DydxPosition,
    level: AlertLevel,
  ): {
    userId: string;
    positionId: string;
    marketId: string;
    side: 'LONG' | 'SHORT';
    distancePct: string;
    liquidationPrice: string;
    oraclePrice: string;
    alertType: string;
    marginType: 'CROSS' | 'ISOLATED';
  } {
    const pct = position.distancePct !== null ? Math.abs(position.distancePct).toFixed(2) : '?';
    const liq = position.liqPrice !== null ? position.liqPrice.toFixed(2) : '?';
    const oracle = position.oraclePrice.toFixed(2);

    return {
      userId: position.address,
      positionId: `${position.subaccountNumber}-${position.market}`,
      marketId: position.market,
      side: position.side,
      distancePct: pct,
      liquidationPrice: liq,
      oraclePrice: oracle,
      alertType: level,
      marginType: position.marginType,
    };
  }
}
