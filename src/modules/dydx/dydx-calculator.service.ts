import { Injectable, Logger } from '@nestjs/common';
import { DydxPosition } from './dydx.types';

@Injectable()
export class DydxCalculatorService {
  private readonly logger = new Logger(DydxCalculatorService.name);

  calculateLiqPrice(
    position: DydxPosition,
    allInSubaccount: DydxPosition[],
  ): number | null {
    const { equity, signedSize: s, entryPrice: p, mmf, oraclePrice, marginType, market } = position;

    if (!s || !p) {
      this.logger.warn(`[${market}] Skipping — zero/null size or entryPrice`);
      return null;
    }
    if (equity <= 0) {
      this.logger.warn(`[${market}] CRITICAL — equity <= 0 (${equity})`);
      return null;
    }

    const absS = Math.abs(s);
    const denom = absS * mmf - s;

    if (denom === 0) {
      this.logger.warn(`[${market}] Skipping — denominator is 0`);
      return null;
    }

    let liq: number;

    if (marginType === 'ISOLATED') {
      liq = (equity - s * p) / denom;
    } else {
      // CROSS: subtract MMR of all OTHER positions in same subaccount
      const mmrOther = allInSubaccount
        .filter((pos) => pos.market !== market)
        .reduce((sum, pos) => sum + Math.abs(pos.signedSize) * pos.oraclePrice * pos.mmf, 0);

      liq = (equity - s * p - mmrOther) / denom;
    }

    if (liq <= 0) {
      this.logger.warn(`[${market}] Skipping — liqPrice <= 0 (${liq})`);
      return null;
    }

    const mmrOtherValue = marginType === 'CROSS'
      ? allInSubaccount
          .filter((pos) => pos.market !== market)
          .reduce((sum, pos) => sum + Math.abs(pos.signedSize) * pos.oraclePrice * pos.mmf, 0)
      : 0;

    this.logger.debug(
      `[${market}] liqPrice=${liq.toFixed(4)}, oracle=${oraclePrice}, side=${position.side}, equity=${equity.toFixed(4)}, mmrOther=${mmrOtherValue.toFixed(4)}`,
    );
    return liq;
  }

  calculateDistancePct(liqPrice: number, oraclePrice: number): number {
    return ((liqPrice - oraclePrice) / oraclePrice) * 100;
  }

  // Enrich an array of positions with liquidation prices and distance percentages.
  //  Groups positions by subaccountNumber so CROSS margin positions see their siblings.

  enrichPositions(positions: DydxPosition[]): DydxPosition[] {
    // Group by subaccountNumber
    const groups = new Map<number, DydxPosition[]>();
    for (const pos of positions) {
      const list = groups.get(pos.subaccountNumber) ?? [];
      list.push(pos);
      groups.set(pos.subaccountNumber, list);
    }

    const enriched: DydxPosition[] = [];
    for (const group of groups.values()) {
      for (const pos of group) {
        const liqPrice = this.calculateLiqPrice(pos, group);
        const distancePct =
          liqPrice !== null ? this.calculateDistancePct(liqPrice, pos.oraclePrice) : null;
        enriched.push({ ...pos, liqPrice, distancePct });
      }
    }
    return enriched;
  }

  /**
   * Enrich a single position with liquidation price.
   * The `allInSubaccount` array must include ALL positions in the subaccount
   * for correct CROSS margin calculation.
   */
  enrichSinglePosition(
    position: DydxPosition,
    allInSubaccount: DydxPosition[],
  ): DydxPosition {
    const liqPrice = this.calculateLiqPrice(position, allInSubaccount);
    const distancePct =
      liqPrice !== null ? this.calculateDistancePct(liqPrice, position.oraclePrice) : null;
    return { ...position, liqPrice, distancePct };
  }
}
