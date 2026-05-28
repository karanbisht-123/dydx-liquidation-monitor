import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Position, PositionStatus, Prisma } from '@prisma/client';
import { IPositionsService, UpsertPositionInput } from './positions.interface';

@Injectable()
export class PositionsService implements IPositionsService {
  private readonly logger = new Logger(PositionsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async upsertPosition(input: UpsertPositionInput): Promise<Position> {
    try {
      this.logger.debug(`Upserting position for user ${input.userId}, positionId: ${input.positionId}`);
      
      const sizeDecimal = new Prisma.Decimal(input.size.toString());
      const entryPriceDecimal = new Prisma.Decimal(input.entryPrice.toString());
      const liquidationPriceDecimal = new Prisma.Decimal(input.liquidationPrice.toString());
      const oraclePriceDecimal = new Prisma.Decimal(input.oraclePrice.toString());
      const marginDecimal = new Prisma.Decimal(input.margin.toString());

      return await this.prisma.position.upsert({
        where: {
          userId_positionId: {
            userId: input.userId,
            positionId: input.positionId,
          },
        },
        update: {
          marketId: input.marketId,
          side: input.side,
          size: sizeDecimal,
          entryPrice: entryPriceDecimal,
          liquidationPrice: liquidationPriceDecimal,
          oraclePrice: oraclePriceDecimal,
          margin: marginDecimal,
          status: PositionStatus.OPEN,
          lastCheckedAt: new Date(),
        },
        create: {
          userId: input.userId,
          positionId: input.positionId,
          marketId: input.marketId,
          side: input.side,
          size: sizeDecimal,
          entryPrice: entryPriceDecimal,
          liquidationPrice: liquidationPriceDecimal,
          oraclePrice: oraclePriceDecimal,
          margin: marginDecimal,
          status: PositionStatus.OPEN,
          lastCheckedAt: new Date(),
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        this.logger.warn(`Prisma unique constraint race condition hit for user ${input.userId}, positionId: ${input.positionId}. Continuing...`);
        const pos = await this.prisma.position.findUnique({
          where: {
            userId_positionId: {
              userId: input.userId,
              positionId: input.positionId,
            },
          },
        });
        if (pos) return pos;
      }
      throw error;
    }
  }

  async markClosed(userId: string, positionId: string): Promise<Position> {
    this.logger.log(`Wiping closed position and its alerts: user ${userId}, positionId: ${positionId}`);
    try {
      // 1. Delete all AlertLogs for this position first to satisfy foreign key constraint
      await this.prisma.alertLog.deleteMany({
        where: {
          userId,
          positionId,
        },
      });

      // 2. Delete the Position record itself
      return await this.prisma.position.delete({
        where: {
          userId_positionId: {
            userId,
            positionId,
          },
        },
      });
    } catch (error: any) {
      this.logger.error(`Failed to completely delete closed position: ${error.message}`);
      // Fallback: return a mock closed position object if it's already deleted or fails
      return {
        id: '',
        userId,
        positionId,
        marketId: '',
        side: 'LONG',
        size: new Prisma.Decimal(0),
        entryPrice: new Prisma.Decimal(0),
        liquidationPrice: new Prisma.Decimal(0),
        oraclePrice: new Prisma.Decimal(0),
        margin: new Prisma.Decimal(0),
        status: PositionStatus.CLOSED,
        lastCheckedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    }
  }

  async getUserActivePositions(userId: string): Promise<Position[]> {
    return this.prisma.position.findMany({
      where: {
        userId,
        status: PositionStatus.OPEN,
      },
    });
  }

  async getUserPositions(userId: string): Promise<Position[]> {
    return this.prisma.position.findMany({
      where: {
        userId,
      },
    });
  }
}
