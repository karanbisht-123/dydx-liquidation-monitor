import { Injectable, Logger, OnModuleInit, HttpException, HttpStatus, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { Decimal } from 'decimal.js';
import { IDydxService, NormalizedPosition } from './dydx.interface';

@Injectable()
export class DydxService implements IDydxService, OnModuleInit {
  private readonly logger = new Logger(DydxService.name);
  private readonly CACHE_KEY = 'dydx:markets';

  constructor(
    private readonly configService: ConfigService,
    @Inject('REDIS_CLIENT')
    private readonly redis: Redis,
  ) {}

  async onModuleInit(): Promise<void> {
    this.logger.log('dYdX Service initializing...');
    try {
      await this.fetchMarketsAndCache();
    } catch (error: any) {
      this.logger.error(`Initial dYdX markets fetch failed: ${error.message}. Will retry on next request.`);
    }
  }

  private async fetchMarketsAndCache(): Promise<any> {
    const baseUrl = this.configService.get<string>('dydx.indexerBaseUrl');
    const ttlMs = this.configService.get<number>('dydx.marketsCacheTtlMs');
    const url = `${baseUrl}/v4/perpetualMarkets`;

    this.logger.log(`Fetching dYdX perpetual markets from: ${url}`);
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const data = await response.json() as any;

      if (!data || !data.markets) {
        throw new Error('Invalid response structure from dYdX perpetualMarkets endpoint');
      }

      // Cache the parsed markets object as a JSON string in Redis
      await this.redis.set(this.CACHE_KEY, JSON.stringify(data.markets), 'PX', ttlMs);
      this.logger.log('dYdX perpetual markets successfully cached in Redis');
      return data.markets;
    } catch (error: any) {
      this.logger.error(`Failed to fetch and cache dYdX markets: ${error.message}`);
      throw new HttpException(
        `Failed to retrieve dYdX markets: ${error.message}`,
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  async getMarkets(): Promise<any> {
    try {
      const cached = await this.redis.get(this.CACHE_KEY);
      if (cached) {
        return JSON.parse(cached);
      }
      return await this.fetchMarketsAndCache();
    } catch (error: any) {
      this.logger.error(`Error retrieving cached markets: ${error.message}`);
      // Fallback: try to fetch directly
      return await this.fetchMarketsAndCache();
    }
  }

  async getMarketData(marketId: string): Promise<{ oraclePrice: Decimal; maintenanceMarginFraction: Decimal } | null> {
    const markets = await this.getMarkets();
    const market = markets[marketId];
    if (!market) {
      return null;
    }
    return {
      oraclePrice: new Decimal(market.oraclePrice || 0),
      maintenanceMarginFraction: new Decimal(market.maintenanceMarginFraction || 0.05),
    };
  }

  async getPositions(walletAddress: string): Promise<NormalizedPosition[]> {
    const baseUrl = this.configService.get<string>('dydx.indexerBaseUrl');
    const url = `${baseUrl}/v4/addresses/${walletAddress}`;

    this.logger.log(`Fetching positions for wallet: ${walletAddress} from ${url}`);
    
    let subaccountsResponse: any;
    try {
      const response = await fetch(url);
      if (response.status === 404) {
        this.logger.log(`Wallet ${walletAddress} has no subaccounts (dYdX 404)`);
        return [];
      }
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      subaccountsResponse = await response.json();
    } catch (error: any) {
      this.logger.error(`Failed to fetch subaccounts for wallet ${walletAddress}: ${error.message}`);
      throw new HttpException(
        `Failed to fetch subaccounts from dYdX: ${error.message}`,
        HttpStatus.BAD_GATEWAY,
      );
    }

    if (!subaccountsResponse || !subaccountsResponse.subaccounts || subaccountsResponse.subaccounts.length === 0) {
      return [];
    }

    const markets = await this.getMarkets();
    const normalizedPositions: NormalizedPosition[] = [];

    for (const subaccount of subaccountsResponse.subaccounts) {
      const openPositionsObj = subaccount.openPerpetualPositions || {};
      const marketIds = Object.keys(openPositionsObj);

      for (const marketId of marketIds) {
        const apiPos = openPositionsObj[marketId];
        if (apiPos.status && apiPos.status !== 'OPEN') {
          continue;
        }

        const marketConfig = markets[marketId];
        if (!marketConfig) {
          this.logger.warn(`Market metadata missing in cache for marketId: ${marketId}. Skipping position.`);
          continue;
        }

        const size = new Decimal(apiPos.size || 0);
        const entryPrice = new Decimal(apiPos.entryPrice || 0);
        const netFunding = new Decimal(apiPos.netFunding || 0);
        const unrealizedPnl = new Decimal(apiPos.unrealizedPnl || 0);
        const leverage = new Decimal(apiPos.leverage || 1);
        const oraclePrice = new Decimal(marketConfig.oraclePrice || 0);
        const maintenanceMarginFraction = new Decimal(marketConfig.maintenanceMarginFraction || 0.05);

        // margin = netFunding + unrealizedPnl + (abs(size) * entryPrice / leverage)
        // Note: size can be negative for SHORT positions, but we use the absolute value for financial leverage math.
        const notionalValue = size.abs().mul(entryPrice);
        const positionMargin = netFunding.add(unrealizedPnl).add(
          notionalValue.div(leverage.isZero() ? new Decimal(1) : leverage)
        );

        const marginType = subaccount.subaccountNumber >= 128 ? 'ISOLATED' : 'CROSS';

        normalizedPositions.push({
          positionId: `${subaccount.subaccountNumber}-${marketId}`, // Unique within this subaccount
          marketId,
          side: apiPos.side as 'LONG' | 'SHORT',
          size,
          entryPrice,
          oraclePrice,
          margin: positionMargin,
          maintenanceMarginFraction,
          marginType,
        });
      }
    }

    return normalizedPositions;
  }
}
