import { Injectable, Logger } from '@nestjs/common';
import { IRiskService, PositionRiskInput } from './risk.interface';
import { Decimal } from 'decimal.js';
import { AlertType } from '@prisma/client';

@Injectable()
export class RiskService implements IRiskService {
  private readonly logger = new Logger(RiskService.name);

  calculateLiquidationPrice(position: PositionRiskInput): Decimal {
    const { size, oraclePrice, maintenanceMarginFraction, entryPrice, margin, side } = position;

    // MMR = Size * OraclePrice * MMF
    const mmr = size.mul(oraclePrice).mul(maintenanceMarginFraction);

    if (size.isZero()) {
      return entryPrice;
    }

    let liquidationPrice: Decimal;

    if (position.equity) {
      /**
       * Official dYdX v4 Liquidation Formula for Subaccount:
       *
       * Liquidation happens when:
       *   Account Equity < Total Subaccount Maintenance Margin Requirement (MMR)
       *
       * Let s = signed position size (+ for LONG, - for SHORT)
       * Let abs(s) = absolute size
       * Let p = entry price
       * Let p' = liquidation price
       * Let e = account equity at entry
       * Let MMF = maintenance margin fraction
       * Let MMR_other = sum of MMRs of all other positions in same subaccount (for CROSS margin)
       *
       * At the point of liquidation:
       *   Equity_liq = e + s * (p' - p)
       *   MMR_total_liq = abs(s) * p' * MMF + MMR_other
       *
       * Setting them equal:
       *   e + s * p' - s * p = abs(s) * p' * MMF + MMR_other
       *   p' * (abs(s) * MMF - s) = e - s * p - MMR_other
       *   p' = (e - s * p - MMR_other) / (abs(s) * MMF - s)
       */
      const s = side === 'LONG' ? size : size.negated();
      const absS = size.abs();
      const denom = absS.mul(maintenanceMarginFraction).sub(s);

      if (denom.isZero()) {
        liquidationPrice = entryPrice;
      } else {
        const mmrOtherVal = position.mmrOther || new Decimal(0);
        // p' = (e - s * p - MMR_other) / (abs(s) * MMF - s)
        liquidationPrice = position.equity.sub(s.mul(entryPrice)).sub(mmrOtherVal).div(denom);
      }

      this.logger.log(
        `[calculateLiquidationPrice] Using dYdX Real-Time Equity: ${position.equity.toFixed(4)}, ` +
        `Side: ${side}, Size: ${size}, Entry: ${entryPrice}, Oracle: ${oraclePrice}, ` +
        `MMR Other: ${(position.mmrOther || new Decimal(0)).toFixed(4)}, ` +
        `Calculated Liq Price: ${liquidationPrice.toFixed(4)}`
      );
    } else {
      /**
       * Fallback Formula (using only Margin):
       *
       *   MarginDiff = Margin - MMR_current
       *   Quotient = MarginDiff / Size
       *
       *   For LONG:  LiqPrice = EntryPrice - (Margin - MMR) / Size
       *   For SHORT: LiqPrice = EntryPrice + (Margin - MMR) / Size
       */
      const unrealizedPnl = side === 'LONG'
        ? size.mul(oraclePrice.sub(entryPrice))
        : size.mul(entryPrice.sub(oraclePrice));
      const calcEquity = margin.add(unrealizedPnl);

      this.logger.log(
        `[calculateLiquidationPrice] Fallback to Margin: ${margin}, Side: ${side}, Size: ${size}, Entry: ${entryPrice}, Oracle: ${oraclePrice}, ` +
        `Unrealized P&L: ${unrealizedPnl.toFixed(4)}, Calc Equity: ${calcEquity.toFixed(4)}, MMR: ${mmr.toFixed(4)}`
      );

      const marginDiff = margin.sub(mmr);
      const quotient = marginDiff.div(size);

      if (side === 'LONG') {
        liquidationPrice = entryPrice.sub(quotient);
      } else {
        liquidationPrice = entryPrice.add(quotient);
      }
    }

    if (liquidationPrice.isNegative()) {
      return new Decimal(0);
    }

    return liquidationPrice;
  }

  calculateDistancePct(oraclePrice: Decimal, liquidationPrice: Decimal): Decimal {
    if (oraclePrice.isZero()) {
      return new Decimal(0);
    }
    return oraclePrice.sub(liquidationPrice).abs().div(oraclePrice).mul(100);
  }

  assessRisk(distancePct: Decimal): AlertType | null {
    if (distancePct.lt(3)) {
      return AlertType.CRITICAL;
    }
    if (distancePct.lt(7)) {
      return AlertType.DANGER;
    }
    if (distancePct.lt(15)) {
      return AlertType.WARNING;
    }
    return null;
  }
}
