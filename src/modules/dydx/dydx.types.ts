export interface DydxPosition {
  address: string;
  subaccountNumber: number;
  market: string;
  side: 'LONG' | 'SHORT';
  signedSize: number;
  entryPrice: number;
  equity: number;
  mmf: number;
  marginType: 'CROSS' | 'ISOLATED';
  oraclePrice: number;
  liqPrice: number | null;
  distancePct: number | null;
}

export interface MarketParams {
  ticker: string;
  oraclePrice: number;
  maintenanceMarginFraction: number;
  initialMarginFraction: number;
}

export enum AlertLevel {
  CRITICAL = 'CRITICAL',
  WARNING = 'WARNING',
}

export interface WatchedAddress {
  address: string;
  fcmToken: string;
}
