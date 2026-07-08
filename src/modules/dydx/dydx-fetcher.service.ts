import { Injectable, Logger, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import {
  DYDX_BASE_URL,
  MARKET_CACHE_TTL_SEC,
  MAX_RETRIES,
} from './dydx.constants';
import { DydxPosition, MarketParams } from './dydx.types';

interface SubaccountApiResponse {
  subaccountNumber: number;
  equity: string;
  openPerpetualPositions: Record<
    string,
    {
      market: string;
      side: 'LONG' | 'SHORT';
      status: string;
      size: string;
      entryPrice: string;
    }
  >;
}

interface AddressApiResponse {
  subaccounts: SubaccountApiResponse[];
}

interface PerpetualMarketsApiResponse {
  markets: Record<
    string,
    {
      ticker: string;
      oraclePrice: string;
      maintenanceMarginFraction: string;
      initialMarginFraction: string;
    }
  >;
}

const MARKET_CACHE_KEY = 'dydx:market_params';

@Injectable()
export class DydxFetcherService {
  private readonly logger = new Logger(DydxFetcherService.name);

  constructor(
    @Inject('REDIS_CLIENT')
    private readonly redis: Redis,
  ) {}

  async getAllPositions(address: string): Promise<DydxPosition[]> {
    const url = `${DYDX_BASE_URL}/addresses/${address}`;
    const data = await this.httpGet<AddressApiResponse>(url);

    const marketParams = await this.getMarketParams();
    const positions: DydxPosition[] = [];

    for (const sub of data.subaccounts ?? []) {
      const marginType = sub.subaccountNumber >= 128 ? 'ISOLATED' : 'CROSS';
      const equity = parseFloat(sub.equity);

      for (const [, pos] of Object.entries(sub.openPerpetualPositions ?? {})) {
        if (pos.status !== 'OPEN') continue;

        const size = parseFloat(pos.size);
        const entryPrice = parseFloat(pos.entryPrice);

        if (!pos.size || !pos.entryPrice || isNaN(size) || isNaN(entryPrice) || size === 0) {
          this.logger.warn(
            `Skipping position ${pos.market} sub#${sub.subaccountNumber}: invalid size/entryPrice`,
          );
          continue;
        }

        const market = marketParams[pos.market];
        if (!market) {
          this.logger.warn(
            `Market ${pos.market} not found in perpetualMarkets response — skipping`,
          );
          continue;
        }

        const signedSize = pos.side === 'LONG' ? size : -size;

        positions.push({
          address,
          subaccountNumber: sub.subaccountNumber,
          market: pos.market,
          side: pos.side,
          signedSize,
          entryPrice,
          equity,
          mmf: market.maintenanceMarginFraction,
          marginType,
          oraclePrice: market.oraclePrice,
          liqPrice: null,
          distancePct: null,
        });
      }
    }

    return positions;
  }

  async getMarketParams(): Promise<Record<string, MarketParams>> {
    // Try cache first
    try {
      const cached = await this.redis.get(MARKET_CACHE_KEY);
      if (cached) {
        return JSON.parse(cached) as Record<string, MarketParams>;
      }
    } catch (err: unknown) {
      this.logger.warn(`Redis read failed for market cache: ${(err as Error).message}`);
    }

    // Fetch from API
    let fetched: Record<string, MarketParams> | null = null;
    try {
      const url = `${DYDX_BASE_URL}/perpetualMarkets`;
      const data = await this.httpGet<PerpetualMarketsApiResponse>(url);
      fetched = this.parseMarkets(data);

      await this.redis.set(
        MARKET_CACHE_KEY,
        JSON.stringify(fetched),
        'EX',
        MARKET_CACHE_TTL_SEC,
      );
      return fetched;
    } catch (err: unknown) {
      this.logger.error(`Failed to fetch perpetualMarkets: ${(err as Error).message}`);

      // Stale fallback
      try {
        const stale = await this.redis.get(MARKET_CACHE_KEY);
        if (stale) {
          this.logger.warn('Using stale market params from Redis after API failure');
          return JSON.parse(stale) as Record<string, MarketParams>;
        }
      } catch (_) {
        // ignore secondary redis error
      }

      throw err;
    }
  }

  private parseMarkets(
    data: PerpetualMarketsApiResponse,
  ): Record<string, MarketParams> {
    const result: Record<string, MarketParams> = {};
    for (const [ticker, m] of Object.entries(data.markets ?? {})) {
      result[ticker] = {
        ticker,
        oraclePrice: parseFloat(m.oraclePrice),
        maintenanceMarginFraction: parseFloat(m.maintenanceMarginFraction),
        initialMarginFraction: parseFloat(m.initialMarginFraction),
      };
    }
    return result;
  }

  async httpGet<T>(url: string): Promise<T> {
    let attempt = 0;
    while (true) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000);

        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);

        if (res.status === 429 || res.status >= 500) {
          if (attempt < MAX_RETRIES) {
            const wait = Math.pow(2, attempt) * 1000;
            this.logger.warn(
              `HTTP ${res.status} on ${url} — retry ${attempt + 1}/${MAX_RETRIES} in ${wait}ms`,
            );
            await new Promise((r) => setTimeout(r, wait));
            attempt++;
            continue;
          }
          throw new Error(`HTTP ${res.status} after ${MAX_RETRIES} retries: ${url}`);
        }

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${url}`);
        }

        return (await res.json()) as T;
      } catch (err: unknown) {
        if (attempt < MAX_RETRIES && !(err instanceof Error && err.message.startsWith('HTTP'))) {
          const wait = Math.pow(2, attempt) * 1000;
          this.logger.warn(
            `Fetch error on ${url} — retry ${attempt + 1}/${MAX_RETRIES} in ${wait}ms: ${(err as Error).message}`,
          );
          await new Promise((r) => setTimeout(r, wait));
          attempt++;
          continue;
        }
        throw err;
      }
    }
  }

  async getSubaccountEquities(address: string): Promise<Record<number, number>> {
    const url = `${DYDX_BASE_URL}/addresses/${address}`;
    try {
      const data = await this.httpGet<any>(url);
      const equities: Record<number, number> = {};
      for (const sub of data.subaccounts ?? []) {
        equities[sub.subaccountNumber] = parseFloat(sub.equity || '0');
      }
      return equities;
    } catch {
      return {};
    }
  }

  async getSubaccount(address: string, subaccountNumber: number): Promise<{ equity: number } | null> {
    const url = `${DYDX_BASE_URL}/addresses/${address}/subaccounts/${subaccountNumber}`;
    try {
      const data = await this.httpGet<any>(url);
      const sub = data.subaccount || data;
      return {
        equity: parseFloat(sub.equity || '0'),
      };
    } catch {
      return null;
    }
  }
}
