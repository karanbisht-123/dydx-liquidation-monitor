import { Decimal } from 'decimal.js';
import { AlertType } from '@prisma/client';

export interface PositionRiskInput {
  size: Decimal;
  oraclePrice: Decimal;
  maintenanceMarginFraction: Decimal;
  entryPrice: Decimal;
  margin: Decimal;
  side: 'LONG' | 'SHORT';
}

export interface IRiskService {
  calculateLiquidationPrice(position: PositionRiskInput): Decimal;
  calculateDistancePct(oraclePrice: Decimal, liquidationPrice: Decimal): Decimal;
  assessRisk(distancePct: Decimal): AlertType | null;
}
