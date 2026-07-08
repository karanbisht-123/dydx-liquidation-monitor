import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { DydxFetcherService } from './dydx-fetcher.service';
import { DydxCalculatorService } from './dydx-calculator.service';
import { DydxDbService } from './dydx-db.service';
import { DydxLiqIndexService } from './dydx-liq-index.service';
import { DydxEventsService } from './dydx-events.service';
import { DydxPosition, DydxEvent, AlertLevel } from './dydx.types';
import {
  POLL_INTERVAL_MS,
  WARNING_CHECK_INTERVAL_MS,
  CRITICAL_THRESHOLD_PCT,
  WARNING_THRESHOLD_PCT,
  SYNC_CONCURRENCY,
} from './dydx.constants';


class Semaphore {
  private running = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly concurrency: number) { }

  async acquire(): Promise<void> {
    if (this.running < this.concurrency) {
      this.running++;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.running++;
  }

  release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) next();
  }
}


interface PositionChange {
  type: 'new' | 'closed' | 'modified';
  position: DydxPosition;
  previous?: DydxPosition;
}

@Injectable()
export class DydxLiquidationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DydxLiquidationService.name);
  private readonly semaphore = new Semaphore(SYNC_CONCURRENCY);
  private syncIntervalId: NodeJS.Timeout | null = null;
  private warningIntervalId: NodeJS.Timeout | null = null;

  constructor(
    private readonly fetcher: DydxFetcherService,
    private readonly calculator: DydxCalculatorService,
    private readonly db: DydxDbService,
    private readonly liqIndex: DydxLiqIndexService,
    private readonly events: DydxEventsService,
  ) { }

  async onModuleInit(): Promise<void> {
    this.logger.log(
      `dYdX Liquidation Monitor v2 starting (sync concurrency=${SYNC_CONCURRENCY}, ` +
      `sync interval=${POLL_INTERVAL_MS}ms, warning interval=${WARNING_CHECK_INTERVAL_MS}ms)`,
    );

    // Run initial sync immediately
    void this.runSyncCycle();
    this.syncIntervalId = setInterval(() => void this.runSyncCycle(), POLL_INTERVAL_MS);

    // Run initial warning check after a short delay (let first sync populate the index)
    setTimeout(() => void this.runWarningCheck(), 5000);
    this.warningIntervalId = setInterval(
      () => void this.runWarningCheck(),
      WARNING_CHECK_INTERVAL_MS,
    );
  }

  onModuleDestroy(): void {
    if (this.syncIntervalId) {
      clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
    if (this.warningIntervalId) {
      clearInterval(this.warningIntervalId);
      this.warningIntervalId = null;
    }
  }

  private async runSyncCycle(): Promise<void> {
    let watchedAddresses: Awaited<ReturnType<DydxDbService['getWatchedAddresses']>>;

    try {
      watchedAddresses = await this.db.getWatchedAddresses();
    } catch (err: unknown) {
      this.logger.error(`getWatchedAddresses failed: ${(err as Error).message}`);
      return;
    }

    if (watchedAddresses.length === 0) {
      this.logger.debug('No active watched addresses — skipping sync cycle');
      return;
    }

    let marketParams: Awaited<ReturnType<DydxFetcherService['getMarketParams']>>;
    try {
      marketParams = await this.fetcher.getMarketParams();
    } catch (err: unknown) {
      this.logger.error(
        `Market params unavailable — aborting sync cycle: ${(err as Error).message}`,
      );
      return;
    }

    let totalPositions = 0;
    let totalNew = 0;
    let totalClosed = 0;
    let totalModified = 0;
    let totalLiquidations = 0;

    // Collect all subaccounts that need full recalculation (CROSS margin groups)
    const dirtySubaccounts = new Set<string>();

    const results = await Promise.allSettled(
      watchedAddresses.map(({ address, fcmToken }) =>
        this.semaphore
          .acquire()
          .then(async () => {
            try {
              const counts = await this.processAddress(
                address,
                marketParams,
                dirtySubaccounts,
              );
              totalPositions += counts.positions;
              totalNew += counts.newPos;
              totalClosed += counts.closed;
              totalModified += counts.modified;
              totalLiquidations += counts.liquidations;
            } finally {
              this.semaphore.release();
            }
          }),
      ),
    );

    const failures = results.filter((r) => r.status === 'rejected');
    for (const f of failures) {
      this.logger.error(`Unhandled address error: ${(f as PromiseRejectedResult).reason}`);
    }

    this.logger.log(
      `Sync cycle done — addresses=${watchedAddresses.length}, positions=${totalPositions}, ` +
      `new=${totalNew}, closed=${totalClosed}, modified=${totalModified}, ` +
      `liquidations=${totalLiquidations}, failures=${failures.length}`,
    );
  }

  /**
   * Process a single address: fetch positions, detect changes, update index.
   * Populates dirtySubaccounts set for CROSS margin recalculation.
   */
  private async processAddress(
    address: string,
    marketParams: Record<string, { ticker: string; oraclePrice: number; maintenanceMarginFraction: number; initialMarginFraction: number }>,
    dirtySubaccounts: Set<string>,
  ): Promise<{ positions: number; newPos: number; closed: number; modified: number; liquidations: number }> {
    let equities: Record<number, number> = {};
    try {
      equities = await this.fetcher.getSubaccountEquities(address);
    } catch (err: unknown) {
      this.logger.error(`Failed to fetch subaccount equities for ${address}: ${(err as Error).message}`);
    }

    let localDbPositions: any[] = [];
    try {
      localDbPositions = await this.db.getLocalOpenPositions(address);
    } catch (localErr) {
      this.logger.error(`Failed to fetch local database positions for ${address}: ${(localErr as Error).message}`);
    }

    const currentPositions: DydxPosition[] = [];
    for (const localPos of localDbPositions) {
      const subNum = localPos.subaccountNumber;
      const market = marketParams[localPos.marketId];
      if (!market) continue;

      const equityVal = equities[subNum] !== undefined ? equities[subNum] : Number(localPos.margin);

      currentPositions.push({
        address,
        subaccountNumber: subNum,
        market: localPos.marketId,
        side: localPos.side,
        signedSize: localPos.side === 'LONG' ? Number(localPos.size) : -Number(localPos.size),
        entryPrice: Number(localPos.entryPrice),
        equity: equityVal,
        mmf: market.maintenanceMarginFraction,
        marginType: subNum >= 128 ? 'ISOLATED' : 'CROSS',
        oraclePrice: market.oraclePrice,
        liqPrice: null,
        distancePct: null,
      });
    }

    // Get previous snapshot from DB
    const previousSnapshot = await this.db.getSnapshotPositions(address);

    // Build a map of current positions keyed by subaccountNumber:marketId
    const currentMap = new Map<string, DydxPosition>();
    for (const pos of currentPositions) {
      const key = `${pos.subaccountNumber}:${pos.market}`;
      currentMap.set(key, pos);
    }

    // Build a set of previous snapshot keys
    const previousSet = new Set<string>();
    for (const snap of previousSnapshot) {
      previousSet.add(`${snap.subaccountNumber}:${snap.market}`);
    }

    const counts = { positions: currentPositions.length, newPos: 0, closed: 0, modified: 0, liquidations: 0 };

    // ── Detect changes ──────────────────────────────────────────────────────

    // 1. New positions (in current but not in previous)
    for (const [key, pos] of currentMap) {
      if (!previousSet.has(key)) {
        counts.newPos++;
        const subKey = `${address}:${pos.subaccountNumber}`;
        if (pos.marginType === 'CROSS') {
          dirtySubaccounts.add(subKey);
        }
      }
    }

    // 2. Closed positions (in previous but not in current)
    for (const key of previousSet) {
      if (!currentMap.has(key)) {
        const [subNumStr, market] = key.split(':');
        const subNum = parseInt(subNumStr, 10);
        counts.closed++;
        // Remove from sorted index
        await this.liqIndex.remove(address, subNum, market);
        // Clean up DB
        await this.db.deleteClosedPosition(address, subNum, market);
        // Emit event
        await this.events.emitPositionClosed(address, subNum, market, 'LONG'); // side not known from snapshot key
      }
    }

    // 3. Modified positions (in both, check if size/entry changed)
    const changedSubaccounts = new Set<string>();
    for (const [key, pos] of currentMap) {
      if (!previousSet.has(key)) continue; // already handled as new

      // Check if position data changed by comparing against stored snapshot
      const snapshot = await this.db.getSnapshotPosition(address, pos.subaccountNumber, pos.market);
      if (snapshot) {
        const sizeChanged = snapshot.signed_size !== pos.signedSize;
        const entryChanged = snapshot.entry_price !== pos.entryPrice;
        if (sizeChanged || entryChanged) {
          counts.modified++;
          const subKey = `${address}:${pos.subaccountNumber}`;
          changedSubaccounts.add(subKey);
          if (pos.marginType === 'CROSS') {
            dirtySubaccounts.add(subKey);
          }
        }
      }
    }

    // ── Enrich and update index ────────────────────────────────────────────

    // Group all current positions by subaccountNumber for enrichment
    const groups = new Map<number, DydxPosition[]>();
    for (const pos of currentPositions) {
      const list = groups.get(pos.subaccountNumber) ?? [];
      list.push(pos);
      groups.set(pos.subaccountNumber, list);
    }

    // Enrich all positions (calculate liqPrice) — for CROSS margin, this
    // automatically accounts for sibling positions because we pass the full group
    const enriched = this.calculator.enrichPositions(currentPositions);

    for (const pos of enriched) {
      if (pos.liqPrice !== null) {
        // Always update the sorted set (even if unchanged, ZADD is idempotent and cheap)
        await this.liqIndex.upsert(
          pos.address,
          pos.subaccountNumber,
          pos.market,
          pos.side,
          pos.liqPrice,
        );
      }

      // Upsert snapshot in DB
      this.db.upsertPositionSnapshot(pos);
    }

    // ── Price tick liquidation check ──────────────────────────────────────

    // Check each market for price movements that may have triggered liquidations
    const marketsToCheck = new Set<string>();
    for (const pos of enriched) {
      marketsToCheck.add(pos.market);
    }

    for (const marketId of marketsToCheck) {
      const liqs = await this.checkLiquidationsForMarket(marketId, marketParams);
      counts.liquidations += liqs;
    }

    return counts;
  }

  // ── Price Tick Liquidation Check ───────────────────────────────────────────
  //
  // For each market, compare previous price to current price and range-query
  // the sorted set to find ONLY the positions that were just liquidated.
  // This is O(log N + K) where K = number of liquidated positions, not O(N).
  //

  /**
   * Check a single market for liquidation events using range queries on the
   * sorted set index. Returns the number of liquidated positions found.
   */
  private async checkLiquidationsForMarket(
    marketId: string,
    marketParams: Record<string, { oraclePrice: number }>,
  ): Promise<number> {
    const newPrice = marketParams[marketId]?.oraclePrice;
    if (!newPrice) return 0;

    const prevPrice = await this.liqIndex.getLastPrice(marketId);
    if (prevPrice === null) {
      // First time seeing this market — just store the price
      await this.liqIndex.setLastPrice(marketId, newPrice);
      return 0;
    }

    if (Math.abs(newPrice - prevPrice) < 0.001) {
      // Price hasn't changed meaningfully
      return 0;
    }

    let liquidatedCount = 0;

    // Price dropped: check LONG positions (liqPrice between newPrice and prevPrice)
    if (newPrice < prevPrice) {
      const liquidatedLongs = await this.liqIndex.findLiquidatedLongs(marketId, newPrice, prevPrice);
      for (const entry of liquidatedLongs) {
        const parsed = DydxLiqIndexService.parseMember(entry.member);
        if (parsed) {
          await this.liqIndex.remove(parsed.address, parsed.subaccountNumber, parsed.marketId);
          await this.events.emitLiquidation(
            parsed.address,
            parsed.subaccountNumber,
            parsed.marketId,
            'LONG',
            entry.liqPrice,
            newPrice,
          );
          liquidatedCount++;
        }
      }
    }

    // Price rose: check SHORT positions (liqPrice between prevPrice and newPrice)
    if (newPrice > prevPrice) {
      const liquidatedShorts = await this.liqIndex.findLiquidatedShorts(marketId, newPrice, prevPrice);
      for (const entry of liquidatedShorts) {
        const parsed = DydxLiqIndexService.parseMember(entry.member);
        if (parsed) {
          await this.liqIndex.remove(parsed.address, parsed.subaccountNumber, parsed.marketId);
          await this.events.emitLiquidation(
            parsed.address,
            parsed.subaccountNumber,
            parsed.marketId,
            'SHORT',
            entry.liqPrice,
            newPrice,
          );
          liquidatedCount++;
        }
      }
    }

    // Update the last known price
    await this.liqIndex.setLastPrice(marketId, newPrice);

    if (liquidatedCount > 0) {
      this.logger.warn(
        `⚡ ${liquidatedCount} position(s) liquidated on ${marketId} ` +
        `(price moved ${prevPrice.toFixed(2)} → ${newPrice.toFixed(2)})`,
      );
    }

    return liquidatedCount;
  }

  // ── Warning Check (separate, lower frequency) ────────────────────────────────
  //
  // Runs every WARNING_CHECK_INTERVAL_MS (30s). Queries the sorted set for
  // positions near their liquidation price. Emits warning events to the queue.
  // Deduplication is handled by the event worker (DydxEventsWorkerService).
  //

  private async runWarningCheck(): Promise<void> {
    try {
      const marketParams = await this.fetcher.getMarketParams();
      let totalWarnings = 0;

      for (const [marketId, market] of Object.entries(marketParams)) {
        const oraclePrice = market.oraclePrice;
        if (oraclePrice <= 0) continue;

        // Check LONG warnings (within WARNING_THRESHOLD_PCT of liquidation)
        const longWarnings = await this.liqIndex.findLongWarnings(
          marketId,
          oraclePrice,
          WARNING_THRESHOLD_PCT,
        );

        for (const entry of longWarnings) {
          const parsed = DydxLiqIndexService.parseMember(entry.member);
          if (!parsed) continue;

          const distancePct = ((entry.liqPrice - oraclePrice) / oraclePrice) * 100;
          const absDist = Math.abs(distancePct);

          let alertLevel: AlertLevel;
          if (absDist <= CRITICAL_THRESHOLD_PCT) {
            alertLevel = AlertLevel.CRITICAL;
          } else if (absDist <= WARNING_THRESHOLD_PCT) {
            alertLevel = AlertLevel.WARNING;
          } else {
            continue; // outside threshold, skip
          }

          await this.events.emitWarning(
            parsed.address,
            parsed.subaccountNumber,
            parsed.marketId,
            'LONG',
            entry.liqPrice,
            oraclePrice,
            distancePct,
            alertLevel,
          );
          totalWarnings++;
        }

        // Check SHORT warnings (within WARNING_THRESHOLD_PCT of liquidation)
        const shortWarnings = await this.liqIndex.findShortWarnings(
          marketId,
          oraclePrice,
          WARNING_THRESHOLD_PCT,
        );

        for (const entry of shortWarnings) {
          const parsed = DydxLiqIndexService.parseMember(entry.member);
          if (!parsed) continue;

          const distancePct = ((entry.liqPrice - oraclePrice) / oraclePrice) * 100;
          const absDist = Math.abs(distancePct);

          let alertLevel: AlertLevel;
          if (absDist <= CRITICAL_THRESHOLD_PCT) {
            alertLevel = AlertLevel.CRITICAL;
          } else if (absDist <= WARNING_THRESHOLD_PCT) {
            alertLevel = AlertLevel.WARNING;
          } else {
            continue;
          }

          await this.events.emitWarning(
            parsed.address,
            parsed.subaccountNumber,
            parsed.marketId,
            'SHORT',
            entry.liqPrice,
            oraclePrice,
            distancePct,
            alertLevel,
          );
          totalWarnings++;
        }
      }

      if (totalWarnings > 0) {
        this.logger.log(`Warning check emitted ${totalWarnings} warning event(s)`);
      }
    } catch (err: unknown) {
      this.logger.error(`runWarningCheck failed: ${(err as Error).message}`);
    }
  }

  // ── Public: Rebuild the entire index from DB snapshots ──────────────────────

  /**
   * Rebuild the sorted-set index from scratch. Useful after Redis flush or
   * first-time setup. Called manually via API or on startup if index is empty.
   */
  async rebuildIndex(): Promise<void> {
    this.logger.log('Rebuilding liquidation index from DB snapshots...');

    try {
      const marketParams = await this.fetcher.getMarketParams();
      const snapshots = await this.db.getAllSnapshots();

      let count = 0;
      for (const snap of snapshots) {
        const market = marketParams[snap.market];
        if (!market || snap.liq_price === null || snap.liq_price <= 0) continue;

        const side = snap.side as 'LONG' | 'SHORT';
        await this.liqIndex.upsert(
          snap.address,
          snap.subaccount_number,
          snap.market,
          side,
          snap.liq_price,
        );

        // Initialize last price for each market
        await this.liqIndex.setLastPrice(snap.market, market.oraclePrice);
        count++;
      }

      this.logger.log(`Index rebuilt with ${count} positions`);
    } catch (err: unknown) {
      this.logger.error(`rebuildIndex failed: ${(err as Error).message}`);
    }
  }
}
