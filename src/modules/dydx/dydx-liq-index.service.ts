import { Injectable, Logger, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { LIQ_INDEX_PREFIX, LAST_PRICE_PREFIX } from './dydx.constants';


@Injectable()
export class DydxLiqIndexService {
  private readonly logger = new Logger(DydxLiqIndexService.name);

  constructor(
    @Inject('REDIS_CLIENT')
    private readonly redis: Redis,
  ) { }

  // Redis keys for long liquidation index
  private longKey(marketId: string): string {
    return `${LIQ_INDEX_PREFIX}:long:${marketId}`;
  }

  // Redis keys for short liquidation index
  private shortKey(marketId: string): string {
    return `${LIQ_INDEX_PREFIX}:short:${marketId}`;
  }


  // Member format stored in Redis sorted sets
  static buildMember(address: string, subaccountNumber: number, marketId: string): string {
    return `${address}:${subaccountNumber}:${marketId}`;
  }


  // Add or update a position in the liquidation index
  async upsert(
    address: string,
    subaccountNumber: number,
    marketId: string,
    side: 'LONG' | 'SHORT',
    liqPrice: number,
  ): Promise<void> {
    const member = DydxLiqIndexService.buildMember(address, subaccountNumber, marketId);


    const pipeline = this.redis.pipeline();
    pipeline.zrem(this.longKey(marketId), member);
    pipeline.zrem(this.shortKey(marketId), member);


    const key = side === 'LONG' ? this.longKey(marketId) : this.shortKey(marketId);
    pipeline.zadd(key, liqPrice, member);

    try {
      await pipeline.exec();
    } catch (err: unknown) {
      this.logger.error(`Failed to upsert liq index [${member}]: ${(err as Error).message}`);
    }
  }

  // Remove a position from both long and short indexes
  async remove(
    address: string,
    subaccountNumber: number,
    marketId: string,
  ): Promise<void> {
    const member = DydxLiqIndexService.buildMember(address, subaccountNumber, marketId);

    try {
      await this.redis
        .pipeline()
        .zrem(this.longKey(marketId), member)
        .zrem(this.shortKey(marketId), member)
        .exec();
    } catch (err: unknown) {
      this.logger.error(`Failed to remove from liq index [${member}]: ${(err as Error).message}`);
    }
  }


  // Find long positions whose liquidation price was crossed
  // between the previous and current price
  async findLiquidatedLongs(
    marketId: string,
    newPrice: number,
    prevPrice: number,
  ): Promise<{ member: string; liqPrice: number }[]> {
    const min = Math.min(newPrice, prevPrice);
    const max = Math.max(newPrice, prevPrice);

    try {
      const results = await this.redis.zrangebyscore(
        this.longKey(marketId),
        min,
        max,
        'WITHSCORES',
      );
      return this.parseWithScores(results);
    } catch (err: unknown) {
      this.logger.error(`findLiquidatedLongs failed [${marketId}]: ${(err as Error).message}`);
      return [];
    }
  }


  // Find short positions whose liquidation price was crossed
  // between the previous and current price
  async findLiquidatedShorts(
    marketId: string,
    newPrice: number,
    prevPrice: number,
  ): Promise<{ member: string; liqPrice: number }[]> {
    const min = Math.min(newPrice, prevPrice);
    const max = Math.max(newPrice, prevPrice);

    try {
      const results = await this.redis.zrangebyscore(
        this.shortKey(marketId),
        min,
        max,
        'WITHSCORES',
      );
      return this.parseWithScores(results);
    } catch (err: unknown) {
      this.logger.error(`findLiquidatedShorts failed [${marketId}]: ${(err as Error).message}`);
      return [];
    }
  }


  // Get long positions that are within the warning threshold
  // (liq price <= oracle price + threshold)
  async findLongWarnings(
    marketId: string,
    oraclePrice: number,
    thresholdPct: number,
  ): Promise<{ member: string; liqPrice: number }[]> {
    const lowerBound = oraclePrice * (1 - thresholdPct / 100);
    try {
      const results = await this.redis.zrangebyscore(
        this.longKey(marketId),
        lowerBound,
        '+inf',
        'WITHSCORES',
      );
      return this.parseWithScores(results);
    } catch (err: unknown) {
      this.logger.error(`findLongWarnings failed[${marketId}]: ${(err as Error).message} `);
      return [];
    }
  }

  // Get short positions that are within the warning threshold
  // (liq price >= oracle price - threshold)
  async findShortWarnings(
    marketId: string,
    oraclePrice: number,
    thresholdPct: number,
  ): Promise<{ member: string; liqPrice: number }[]> {
    const upperBound = oraclePrice * (1 + thresholdPct / 100);
    try {
      const results = await this.redis.zrangebyscore(
        this.shortKey(marketId),
        '-inf',
        upperBound,
        'WITHSCORES',
      );
      return this.parseWithScores(results);
    } catch (err: unknown) {
      this.logger.error(`findShortWarnings failed[${marketId}]: ${(err as Error).message} `);
      return [];
    }
  }

  // Remove multiple positions after liquidation
  async removeMembers(marketId: string, members: string[]): Promise<void> {
    if (members.length === 0) return;
    try {
      await this.redis
        .pipeline()
        .zrem(this.longKey(marketId), ...members)
        .zrem(this.shortKey(marketId), ...members)
        .exec();
    } catch (err: unknown) {
      this.logger.error(`removeMembers failed[${marketId}]: ${(err as Error).message} `);
    }
  }

  // Get the last processed market price
  async getLastPrice(marketId: string): Promise<number | null> {
    try {
      const val = await this.redis.get(`${LAST_PRICE_PREFIX}:${marketId} `);
      return val ? parseFloat(val) : null;
    } catch {
      return null;
    }
  }


  // Store the latest processed market price
  async setLastPrice(marketId: string, price: number): Promise<void> {
    try {
      await this.redis.set(`${LAST_PRICE_PREFIX}:${marketId} `, price.toString());
    } catch (err: unknown) {
      this.logger.error(`setLastPrice failed[${marketId}]: ${(err as Error).message} `);
    }
  }

  // Return all markets that currently have indexed positions
  async getTrackedMarkets(): Promise<string[]> {
    try {
      const keys = await this.redis.keys(`${LIQ_INDEX_PREFIX}: long:* `);
      // Strip prefix to get market IDs
      return keys.map((k) => k.replace(`${LIQ_INDEX_PREFIX}: long:* `, ''));
    } catch (err: unknown) {
      this.logger.error(`getTrackedMarkets failed: ${(err as Error).message} `);
      return [];
    }
  }

  // Get the number of indexed long and short positions
  async getCount(marketId: string): Promise<{ longs: number; shorts: number }> {
    try {
      const [longs, shorts] = await this.redis
        .pipeline()
        .zcard(this.longKey(marketId))
        .zcard(this.shortKey(marketId))
        .exec();
      return {
        longs: (longs as unknown as [Error | null, number])?.[1] ?? 0,
        shorts: (shorts as unknown as [Error | null, number])?.[1] ?? 0,
      };
    } catch {
      return { longs: 0, shorts: 0 };
    }
  }

  // Convert a Redis member back into its original fields
  static parseMember(member: string): { address: string; subaccountNumber: number; marketId: string } | null {
    const parts = member.split(':');
    if (parts.length < 3) return null;
    const marketId = parts[parts.length - 1];
    const subaccountNumber = parseInt(parts[parts.length - 2], 10);
    const address = parts.slice(0, parts.length - 2).join(':');

    if (isNaN(subaccountNumber) || !address || !marketId) return null;
    return { address, subaccountNumber, marketId };
  }

  // Parse ZRANGEBYSCORE WITHSCORES response into objects
  private parseWithScores(results: string[]): { member: string; liqPrice: number }[] {
    const parsed: { member: string; liqPrice: number }[] = [];
    for (let i = 0; i < results.length; i += 2) {
      parsed.push({
        member: results[i],
        liqPrice: parseFloat(results[i + 1]),
      });
    }
    return parsed;
  }
}
