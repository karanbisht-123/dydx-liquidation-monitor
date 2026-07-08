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

// ── Liquidation Index types ──────────────────────────────────────────────────

export interface LiqIndexMember {
  /** Redis sorted-set member, e.g. "0xABC:0:BTC-USD" */
  key: string;
  /** Liquidation price used as the sorted-set score */
  score: number;
}

// ── Event types (Redis Streams) ───────────────────────────────────────────────

export type DydxEventType = 'liquidation' | 'warning' | 'position_opened' | 'position_closed';

export interface DydxEvent {
  type: DydxEventType;
  address: string;
  subaccountNumber: number;
  marketId: string;
  side: 'LONG' | 'SHORT';
  liqPrice: number | null;
  oraclePrice: number;
  distancePct: number | null;
  alertLevel: AlertLevel | null;
  equity: number | null;
  timestamp: number;
}
