import { Decimal } from 'decimal.js';

export interface NormalizedPosition {
  positionId: string;
  marketId: string;
  side: 'LONG' | 'SHORT';
  size: Decimal;
  entryPrice: Decimal;
  oraclePrice: Decimal;
  margin: Decimal;
  maintenanceMarginFraction: Decimal;
  marginType: 'CROSS' | 'ISOLATED';
}

export interface IDydxService {
  getPositions(walletAddress: string): Promise<NormalizedPosition[]>;
  getMarketData(marketId: string): Promise<{ oraclePrice: Decimal; maintenanceMarginFraction: Decimal } | null>;
}
