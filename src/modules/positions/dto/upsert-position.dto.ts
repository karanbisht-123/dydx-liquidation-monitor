import { IsEnum, IsNotEmpty, IsNumber, IsNumberString, IsString, IsOptional } from 'class-validator';
import { PositionSide } from '@prisma/client';

export class UpsertPositionDto {
  @IsOptional()
  @IsString()
  positionId?: string;

  @IsNotEmpty()
  @IsNumber()
  subaccountNumber: number;

  @IsNotEmpty()
  @IsString()
  marketId: string;

  @IsNotEmpty()
  @IsEnum(PositionSide)
  side: PositionSide;

  @IsNotEmpty()
  @IsNumberString()
  size: string;

  @IsNotEmpty()
  @IsNumberString()
  entryPrice: string;

  @IsNotEmpty()
  @IsNumberString()
  margin: string;

  @IsOptional()
  @IsNumberString()
  liquidationPrice?: string;

  @IsOptional()
  @IsNumberString()
  oraclePrice?: string;
}
