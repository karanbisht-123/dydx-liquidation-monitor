import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import Redis from 'ioredis';
import { DydxPosition, WatchedAddress } from './dydx.types';

@Injectable()
export class DydxDbService implements OnModuleInit {
  private readonly logger = new Logger(DydxDbService.name);
  private watchedAddressesCache: { data: WatchedAddress[]; expiresAt: number } | null = null;
  private static readonly WATCHED_CACHE_TTL_MS = 30_000;

  constructor(
    private readonly prisma: PrismaService,
    @Inject('REDIS_CLIENT')
    private readonly redis: Redis,
  ) {}

  async onModuleInit(): Promise<void> {
    // Run cleanup on startup and schedule every 24 hours
    void this.cleanupOldLogs();
    setInterval(() => void this.cleanupOldLogs(), 24 * 60 * 60 * 1000);
  }


  async getWatchedAddresses(): Promise<WatchedAddress[]> {
    const now = Date.now();
    if (this.watchedAddressesCache && this.watchedAddressesCache.expiresAt > now) {
      return this.watchedAddressesCache.data;
    }

    const users = await this.prisma.user.findMany({
      where: { isActive: true, fcmToken: { not: null } },
      select: { walletAddress: true, fcmToken: true },
    });

    const data = users
      .filter((u): u is { walletAddress: string; fcmToken: string } => u.fcmToken !== null)
      .map((u) => ({ address: u.walletAddress, fcmToken: u.fcmToken }));

    this.watchedAddressesCache = { data, expiresAt: now + DydxDbService.WATCHED_CACHE_TTL_MS };
    return data;
  }

  upsertPositionSnapshot(position: DydxPosition): void {
    this.prisma
      .$executeRawUnsafe(
        `INSERT INTO positions_snapshot
           (address, subaccount_number, market, side, signed_size, entry_price,
            liq_price, oracle_price, distance_pct, margin_type, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
         ON CONFLICT (address, subaccount_number, market)
         DO UPDATE SET
           side              = EXCLUDED.side,
           signed_size       = EXCLUDED.signed_size,
           entry_price       = EXCLUDED.entry_price,
           liq_price         = EXCLUDED.liq_price,
           oracle_price      = EXCLUDED.oracle_price,
           distance_pct      = EXCLUDED.distance_pct,
           margin_type       = EXCLUDED.margin_type,
           updated_at        = NOW()`,
        position.address,
        position.subaccountNumber,
        position.market,
        position.side,
        position.signedSize,
        position.entryPrice,
        position.liqPrice,
        position.oraclePrice,
        position.distancePct,
        position.marginType,
      )
      .catch((err: unknown) => {
        this.logger.error(
          `upsertPositionSnapshot failed [${position.market}]: ${(err as Error).message}`,
        );
      });
  }

  async cleanupOldLogs(): Promise<{ deleted: number }> {
    const daysRetention = parseInt(process.env.ALERT_LOG_RETENTION_DAYS || '30', 10);
    this.logger.log(`Starting database cleanup of alert logs older than ${daysRetention} days...`);
    try {
      const cutOffDate = new Date();
      cutOffDate.setDate(cutOffDate.getDate() - daysRetention);

      const deleted = await this.prisma.$executeRawUnsafe(
        `DELETE FROM alert_log WHERE fired_at < $1`,
        cutOffDate,
      );

      this.logger.log(`Cleanup complete: deleted ${deleted} alert log rows`);
      return { deleted };
    } catch (err: unknown) {
      this.logger.error(`Database cleanup failed: ${(err as Error).message}`);
      return { deleted: 0 };
    }
  }

  async deleteClosedPosition(address: string, subaccountNumber: number, market: string): Promise<void> {
    try {
      await this.prisma.$executeRawUnsafe(
        `DELETE FROM positions_snapshot WHERE address = $1 AND subaccount_number = $2 AND market = $3`,
        address,
        subaccountNumber,
        market,
      );

      await this.prisma.$executeRawUnsafe(
        `DELETE FROM alert_log WHERE address = $1 AND subaccount_number = $2 AND market = $3`,
        address,
        subaccountNumber,
        market,
      );

      const positionId = `${subaccountNumber}-${market}`;
      const user = await this.prisma.user.findUnique({
        where: { walletAddress: address },
        select: { id: true },
      });
      if (user) {
        await this.prisma.position.updateMany({
          where: { userId: user.id, positionId, status: 'OPEN' },
          data: { status: 'CLOSED' },
        });
      }

      try {
        await this.redis.del(
          `dydx:alert:${address}:${subaccountNumber}:${market}:WARNING`,
          `dydx:alert:${address}:${subaccountNumber}:${market}:CRITICAL`,
        );
      } catch (redisErr: unknown) {
        this.logger.warn(`Failed to delete Redis dedup keys for closed position: ${(redisErr as Error).message}`);
      }
    } catch (err: unknown) {
      this.logger.error(`deleteClosedPosition failed: ${(err as Error).message}`);
    }
  }

  async getSnapshotPositions(address: string): Promise<{ subaccountNumber: number; market: string; signed_size: number; entry_price: number }[]> {
    try {
      const rows = await this.prisma.$queryRawUnsafe<{ subaccount_number: number; market: string; signed_size: string; entry_price: string }[]>(
        `SELECT subaccount_number, market, signed_size, entry_price FROM positions_snapshot WHERE address = $1`,
        address,
      );
      return rows.map((r) => ({
        subaccountNumber: Number(r.subaccount_number),
        market: r.market,
        signed_size: parseFloat(r.signed_size),
        entry_price: parseFloat(r.entry_price),
      }));
    } catch (err: unknown) {
      this.logger.error(`getSnapshotPositions failed: ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * Get a single position snapshot from the DB for change detection.
   */
  async getSnapshotPosition(
    address: string,
    subaccountNumber: number,
    market: string,
  ): Promise<{ signed_size: number; entry_price: number; side: string } | null> {
    try {
      const rows = await this.prisma.$queryRawUnsafe<{ signed_size: string; entry_price: string; side: string }[]>(
        `SELECT signed_size, entry_price, side FROM positions_snapshot
         WHERE address = $1 AND subaccount_number = $2 AND market = $3`,
        address,
        subaccountNumber,
        market,
      );
      if (rows.length === 0) return null;
      return {
        signed_size: parseFloat(rows[0].signed_size),
        entry_price: parseFloat(rows[0].entry_price),
        side: rows[0].side,
      };
    } catch (err: unknown) {
      this.logger.error(`getSnapshotPosition failed: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Get ALL snapshots — used for rebuilding the sorted-set index from scratch.
   */
  async getAllSnapshots(): Promise<{
    address: string;
    subaccount_number: number;
    market: string;
    side: string;
    liq_price: number | null;
  }[]> {
    try {
      const rows = await this.prisma.$queryRawUnsafe<{
        address: string;
        subaccount_number: number;
        market: string;
        side: string;
        liq_price: string | null;
      }[]>(
        `SELECT address, subaccount_number, market, side, liq_price FROM positions_snapshot`,
      );
      return rows.map((r) => ({
        address: r.address,
        subaccount_number: Number(r.subaccount_number),
        market: r.market,
        side: r.side,
        liq_price: r.liq_price !== null ? parseFloat(r.liq_price) : null,
      }));
    } catch (err: unknown) {
      this.logger.error(`getAllSnapshots failed: ${(err as Error).message}`);
      return [];
    }
  }

  async getLocalOpenPositions(address: string): Promise<any[]> {
    return this.prisma.position.findMany({
      where: {
        user: { walletAddress: address },
        status: 'OPEN',
      },
    });
  }
}
