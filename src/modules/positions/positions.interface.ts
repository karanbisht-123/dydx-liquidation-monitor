import { Position, PositionSide } from '@prisma/client';
import { Decimal } from 'decimal.js';

export interface UpsertPositionInput {
  userId: string;
  positionId: string;
  marketId: string;
  subaccountNumber: number;
  side: PositionSide;
  size: Decimal;
  entryPrice: Decimal;
  liquidationPrice: Decimal;
  oraclePrice: Decimal;
  margin: Decimal;
}

export interface IPositionsService {
  upsertPosition(input: UpsertPositionInput): Promise<Position>;
  createPosition(input: UpsertPositionInput): Promise<Position>;
  updatePosition(userId: string, positionId: string, input: Omit<UpsertPositionInput, 'userId' | 'positionId'>): Promise<Position>;
  markClosed(userId: string, positionId: string): Promise<Position>;
  getUserActivePositions(userId: string): Promise<Position[]>;
  getUserPositions(userId: string): Promise<Position[]>;
  updateOraclePrice(userId: string, positionId: string, oraclePrice: Decimal): Promise<Position>;
}
