import { Injectable, Logger } from '@nestjs/common';
import { IRiskService, PositionRiskInput } from './risk.interface';
import { Decimal } from 'decimal.js';
import { AlertType } from '@prisma/client';

@Injectable()
export class RiskService implements IRiskService {
  private readonly logger = new Logger(RiskService.name);

  calculateLiquidationPrice(position: PositionRiskInput): Decimal {
    const { size, oraclePrice, maintenanceMarginFraction, entryPrice, margin, side } = position;

    const mmr = size.mul(oraclePrice).mul(maintenanceMarginFraction);

    if (size.isZero()) {
      return entryPrice;
    }

    const marginDiff = margin.sub(mmr);
    const quotient = marginDiff.div(size);

    let liquidationPrice: Decimal;
    if (side === 'LONG') {
      liquidationPrice = entryPrice.sub(quotient);
    } else {
      liquidationPrice = entryPrice.add(quotient);
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
