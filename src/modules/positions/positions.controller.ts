import { Controller, Get, Param, NotFoundException, Inject } from '@nestjs/common';
import { IPositionsService } from './positions.interface';
import { IUsersService } from '../users/users.interface';
import { IRiskService } from '../risk/risk.interface';
import { Decimal } from 'decimal.js';

@Controller('users')
export class PositionsController {
  constructor(
    @Inject('IPositionsService')
    private readonly positionsService: IPositionsService,
    @Inject('IUsersService')
    private readonly usersService: IUsersService,
    @Inject('IRiskService')
    private readonly riskService: IRiskService,
  ) {}

  @Get(':walletAddress/positions')
  async getUserPositions(@Param('walletAddress') walletAddress: string): Promise<any[]> {
    const user = await this.usersService.getUserByWallet(walletAddress);
    if (!user) {
      throw new NotFoundException(`User with wallet ${walletAddress} not found`);
    }

    const positions = await this.positionsService.getUserPositions(user.id);

    return positions.map((pos) => {
      const oraclePrice = new Decimal(pos.oraclePrice.toString());
      const liquidationPrice = new Decimal(pos.liquidationPrice.toString());

      const distancePct = this.riskService.calculateDistancePct(oraclePrice, liquidationPrice);
      const riskLevel = this.riskService.assessRisk(distancePct);

      return {
        id: pos.id,
        positionId: pos.positionId,
        marketId: pos.marketId,
        side: pos.side,
        size: pos.size.toString(),
        entryPrice: pos.entryPrice.toString(),
        liquidationPrice: pos.liquidationPrice.toString(),
        oraclePrice: pos.oraclePrice.toString(),
        margin: pos.margin.toString(),
        status: pos.status,
        distancePct: distancePct.toNumber(),
        riskLevel: riskLevel || 'SAFE',
        lastCheckedAt: pos.lastCheckedAt,
        createdAt: pos.createdAt,
        updatedAt: pos.updatedAt,
      };
    });
  }
}
