import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { DydxFetcherService } from './dydx-fetcher.service';
import { DydxCalculatorService } from './dydx-calculator.service';
import { DydxAlertService } from './dydx-alert.service';
import { DydxDbService } from './dydx-db.service';
import { POLL_INTERVAL_MS, CRITICAL_THRESHOLD_PCT, WARNING_THRESHOLD_PCT } from './dydx.constants';

/**
 * Simple async semaphore — limits concurrent address processing so a large
 * user base never floods the event loop or the dYdX indexer.
 * Default: 25 concurrent address goroutines per poll 
 */
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

const CONCURRENCY = 25; // max parallel address goroutines

@Injectable()
export class DydxLiquidationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DydxLiquidationService.name);
  private readonly semaphore = new Semaphore(CONCURRENCY);
  private intervalId: NodeJS.Timeout | null = null;

  constructor(
    private readonly fetcher: DydxFetcherService,
    private readonly calculator: DydxCalculatorService,
    private readonly alertService: DydxAlertService,
    private readonly db: DydxDbService,
  ) { }

  async onModuleInit(): Promise<void> {
    this.logger.log(
      `dYdX Liquidation Monitor starting (concurrency=${CONCURRENCY}, interval=${POLL_INTERVAL_MS}ms)`,
    );
    this.intervalId = setInterval(() => void this.runCycle(), POLL_INTERVAL_MS);
    void this.runCycle();
  }

  onModuleDestroy(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async runCycle(): Promise<void> {
    let watchedAddresses: Awaited<ReturnType<DydxDbService['getWatchedAddresses']>>;

    try {
      watchedAddresses = await this.db.getWatchedAddresses();
    } catch (err: unknown) {
      this.logger.error(`getWatchedAddresses failed: ${(err as Error).message}`);
      return;
    }

    if (watchedAddresses.length === 0) {
      this.logger.debug('No active watched addresses — skipping cycle');
      return;
    }

    // Pre-warm market params once per cycle; abort if unavailable
    try {
      await this.fetcher.getMarketParams();
    } catch (err: unknown) {
      this.logger.error(
        `Market params unavailable — aborting cycle: ${(err as Error).message}`,
      );
      return;
    }

    let totalPositions = 0;
    let totalAlerts = 0;

    // Each address runs inside the semaphore — no more than CONCURRENCY at once.
    // Promise.allSettled ensures one address failure never blocks others.
    const results = await Promise.allSettled(
      watchedAddresses.map(({ address, fcmToken }) =>
        this.semaphore
          .acquire()
          .then(async () => {
            try {
              const counts = await this.processAddress(address, fcmToken);
              totalPositions += counts.positions;
              totalAlerts += counts.alerts;
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
      `Cycle done — addresses=${watchedAddresses.length}, positions=${totalPositions}, ` +
      `alerts=${totalAlerts}, failures=${failures.length}`,
    );
  }

  private async processAddress(
    address: string,
    fcmToken: string,
  ): Promise<{ positions: number; alerts: number }> {
    let rawPositions;
    try {
      rawPositions = await this.fetcher.getAllPositions(address);
    } catch (err: unknown) {
      const msg = (err as Error).message ?? '';
      if (msg.includes('HTTP 404')) {
        this.logger.warn(`${address} — no dYdX account (404), skipping`);
      } else {
        this.logger.error(`getAllPositions failed [${address}]: ${msg}`);
      }
      return { positions: 0, alerts: 0 };
    }

    if (rawPositions.length === 0) return { positions: 0, alerts: 0 };

    const enriched = this.calculator.enrichPositions(rawPositions);
    let alerts = 0;

    for (const pos of enriched) {
      // Fire-and-forget — snapshot write never blocks the alert loop
      this.db.upsertPositionSnapshot(pos);

      try {
        await this.alertService.checkAndAlert(pos, fcmToken);
        if (
          pos.distancePct !== null &&
          Math.abs(pos.distancePct) <= Math.max(CRITICAL_THRESHOLD_PCT, WARNING_THRESHOLD_PCT)
        ) {
          alerts++;
        }
      } catch (err: unknown) {
        this.logger.error(
          `checkAndAlert failed [${address}/${pos.market}]: ${(err as Error).message}`,
        );
      }
    }

    return { positions: enriched.length, alerts };
  }
}
