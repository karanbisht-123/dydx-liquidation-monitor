import { Position, PositionSide } from '@prisma/client';
import { Decimal } from 'decimal.js';

export interface UpsertPositionInput {
  userId: string;
  positionId: string;
  marketId: string;
  side: PositionSide;
  size: Decimal;
  entryPrice: Decimal;
  liquidationPrice: Decimal;
  oraclePrice: Decimal;
  margin: Decimal;
}

export interface IPositionsService {
  upsertPosition(input: UpsertPositionInput): Promise<Position>;
  markClosed(userId: string, positionId: string): Promise<Position>;
  getUserActivePositions(userId: string): Promise<Position[]>;
  getUserPositions(userId: string): Promise<Position[]>;
}
