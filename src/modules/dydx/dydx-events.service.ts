import { Injectable, Logger, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { EVENT_STREAM_KEY } from './dydx.constants';
import { DydxEvent, DydxEventType, AlertLevel } from './dydx.types';

@Injectable()
export class DydxEventsService {
  private readonly logger = new Logger(DydxEventsService.name);

  constructor(
    @Inject('REDIS_CLIENT')
    private readonly redis: Redis,
  ) { }


  async emitEvent(event: DydxEvent): Promise<void> {
    try {
      await this.redis.xadd(
        EVENT_STREAM_KEY,
        'MAXLEN',
        '~',
        '10000',
        '*',
        'type',
        event.type,
        'address',
        event.address,
        'subaccountNumber',
        String(event.subaccountNumber),
        'marketId',
        event.marketId,
        'side',
        event.side,
        'liqPrice',
        event.liqPrice !== null ? String(event.liqPrice) : '',
        'oraclePrice',
        String(event.oraclePrice),
        'distancePct',
        event.distancePct !== null ? String(event.distancePct) : '',
        'alertLevel',
        event.alertLevel ?? '',
        'equity',
        event.equity !== null ? String(event.equity) : '',
        'timestamp',
        String(event.timestamp),
      );
    } catch (err: unknown) {
      this.logger.error(`emitEvent failed [${event.type}]: ${(err as Error).message}`);
    }
  }

  async emitLiquidation(
    address: string,
    subaccountNumber: number,
    marketId: string,
    side: 'LONG' | 'SHORT',
    liqPrice: number,
    oraclePrice: number,
  ): Promise<void> {
    await this.emitEvent({
      type: 'liquidation',
      address,
      subaccountNumber,
      marketId,
      side,
      liqPrice,
      oraclePrice,
      distancePct: null,
      alertLevel: null,
      equity: null,
      timestamp: Date.now(),
    });
  }


  async emitWarning(
    address: string,
    subaccountNumber: number,
    marketId: string,
    side: 'LONG' | 'SHORT',
    liqPrice: number,
    oraclePrice: number,
    distancePct: number,
    alertLevel: AlertLevel,
  ): Promise<void> {
    await this.emitEvent({
      type: 'warning',
      address,
      subaccountNumber,
      marketId,
      side,
      liqPrice,
      oraclePrice,
      distancePct,
      alertLevel,
      equity: null,
      timestamp: Date.now(),
    });
  }

  /**
   * Helper: emit a position opened event.
   */
  async emitPositionOpened(
    address: string,
    subaccountNumber: number,
    marketId: string,
    side: 'LONG' | 'SHORT',
    liqPrice: number,
    oraclePrice: number,
    equity: number,
  ): Promise<void> {
    await this.emitEvent({
      type: 'position_opened',
      address,
      subaccountNumber,
      marketId,
      side,
      liqPrice,
      oraclePrice,
      distancePct: null,
      alertLevel: null,
      equity,
      timestamp: Date.now(),
    });
  }


  async emitPositionClosed(
    address: string,
    subaccountNumber: number,
    marketId: string,
    side: 'LONG' | 'SHORT',
  ): Promise<void> {
    await this.emitEvent({
      type: 'position_closed',
      address,
      subaccountNumber,
      marketId,
      side,
      liqPrice: null,
      oraclePrice: 0,
      distancePct: null,
      alertLevel: null,
      equity: null,
      timestamp: Date.now(),
    });
  }
}
