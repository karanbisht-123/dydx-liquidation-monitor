import { Controller, Get, Param, NotFoundException, Inject, Post, Put, Delete, Body, BadRequestException } from '@nestjs/common';
import { IPositionsService } from './positions.interface';
import { IUsersService } from '../users/users.interface';
import { IRiskService } from '../risk/risk.interface';
import { IDydxService } from '../dydx/dydx.interface';
import { Decimal } from 'decimal.js';
import { UpsertPositionDto } from './dto/upsert-position.dto';
import { WalletAddressValidationPipe } from '../users/pipes/wallet-address-validation.pipe';
import { DydxDbService } from '../dydx/dydx-db.service';
import { DydxLiqIndexService } from '../dydx/dydx-liq-index.service';

@Controller('users')
export class PositionsController {
  constructor(
    @Inject('IPositionsService')
    private readonly positionsService: IPositionsService,
    @Inject('IUsersService')
    private readonly usersService: IUsersService,
    @Inject('IRiskService')
    private readonly riskService: IRiskService,
    @Inject('IDydxService')
    private readonly dydxService: IDydxService,
    private readonly dydxDbService: DydxDbService,
    private readonly dydxLiqIndexService: DydxLiqIndexService,
  ) {}

  @Get(':walletAddress/positions')
  async getUserPositions(
    @Param('walletAddress', WalletAddressValidationPipe) walletAddress: string,
  ): Promise<any[]> {
    const user = await this.usersService.getUserByWallet(walletAddress);
    if (!user) {
      return [];
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

  @Get(':walletAddress/subaccounts')
  async getSubaccounts(
    @Param('walletAddress', WalletAddressValidationPipe) walletAddress: string,
  ): Promise<any[]> {
    // Aggregate positions per subaccount to show portfolio-level health.
    // For CROSS margin (subaccount 0) this is essential because all positions
    // share one equity pool.
    const user = await this.usersService.getUserByWallet(walletAddress);
    if (!user) {
      return [];
    }

    const positions = await this.positionsService.getUserPositions(user.id);

    // Group positions by subaccountNumber (parsed from positionId prefix)
    const subaccountMap = new Map<number, any[]>();
    for (const pos of positions) {
      const subNum = parseInt(pos.positionId.split('-')[0], 10) || 0;
      const list = subaccountMap.get(subNum) ?? [];
      list.push(pos);
      subaccountMap.set(subNum, list);
    }

    const result: any[] = [];
    for (const [subaccountNumber, subPositions] of subaccountMap.entries()) {
      const marginType = subaccountNumber >= 128 ? 'ISOLATED' : 'CROSS';

      // Aggregate metrics for this subaccount
      let totalMargin = new Decimal(0);
      let totalNotional = new Decimal(0);
      const positionSummaries: any[] = [];

      for (const pos of subPositions) {
        const size = new Decimal(pos.size.toString());
        const entryPrice = new Decimal(pos.entryPrice.toString());
        const margin = new Decimal(pos.margin.toString());
        const oraclePrice = new Decimal(pos.oraclePrice.toString());
        const liquidationPrice = new Decimal(pos.liquidationPrice.toString());

        const notional = size.abs().mul(entryPrice);
        totalMargin = totalMargin.add(margin);
        totalNotional = totalNotional.add(notional);

        const distancePct = this.riskService.calculateDistancePct(oraclePrice, liquidationPrice);
        const riskLevel = this.riskService.assessRisk(distancePct);

        positionSummaries.push({
          positionId: pos.positionId,
          marketId: pos.marketId,
          side: pos.side,
          size: pos.size.toString(),
          entryPrice: pos.entryPrice.toString(),
          liquidationPrice: pos.liquidationPrice.toString(),
          oraclePrice: pos.oraclePrice.toString(),
          margin: pos.margin.toString(),
          distancePct: distancePct.toNumber(),
          riskLevel: riskLevel || 'SAFE',
        });
      }

      // Health ratio = total margin / total notional (rough leverage/health indicator)
      const healthPct = totalNotional.gt(0)
        ? totalMargin.div(totalNotional).mul(100).toNumber()
        : 100;

      result.push({
        subaccountNumber,
        marginType,
        equity: totalMargin.toString(),
        totalNotional: totalNotional.toString(),
        healthPct: Number(healthPct.toFixed(2)),
        positionCount: subPositions.length,
        positions: positionSummaries,
      });
    }

    return result;
  }

  @Post(':walletAddress/positions')
  async createPosition(
    @Param('walletAddress', WalletAddressValidationPipe) walletAddress: string,
    @Body() dto: UpsertPositionDto,
  ) {
    const sizeDecimal = new Decimal(dto.size);
    const entryPriceDecimal = new Decimal(dto.entryPrice);
    const marginDecimal = new Decimal(dto.margin);

    let liquidationPrice: Decimal;
    let oraclePrice: Decimal;
    let user: any;

    if (dto.liquidationPrice !== undefined && dto.oraclePrice !== undefined) {
      liquidationPrice = new Decimal(dto.liquidationPrice);
      oraclePrice = new Decimal(dto.oraclePrice);
      user = await this.usersService.getOrCreateUser(walletAddress);
    } else {
      const [u, marketData, subaccount] = await Promise.all([
        this.usersService.getOrCreateUser(walletAddress),
        this.dydxService.getMarketData(dto.marketId),
        this.dydxService.getParentSubaccount(walletAddress, dto.subaccountNumber),
      ]);
      user = u;

      if (!marketData) {
        throw new BadRequestException(`Market parameters not found for marketId: ${dto.marketId}`);
      }

      oraclePrice = marketData.oraclePrice;

      let mmrOther = new Decimal(0);
      if (dto.subaccountNumber < 128 && subaccount && subaccount.openPerpetualPositions) {
        const markets = await this.dydxService.getMarkets();
        for (const [mId, pos] of Object.entries(subaccount.openPerpetualPositions)) {
          if (mId === dto.marketId) continue;
          const marketConfig = markets[mId];
          if (marketConfig) {
            const posSize = new Decimal((pos as any).size || 0).abs();
            const oPrice = new Decimal(marketConfig.oraclePrice || 0);
            const mmf = new Decimal(marketConfig.maintenanceMarginFraction || 0.05);
            mmrOther = mmrOther.add(posSize.mul(oPrice).mul(mmf));
          }
        }
      }

      liquidationPrice = this.riskService.calculateLiquidationPrice({
        size: sizeDecimal,
        oraclePrice: marketData.oraclePrice,
        maintenanceMarginFraction: marketData.maintenanceMarginFraction,
        entryPrice: entryPriceDecimal,
        margin: marginDecimal,
        side: dto.side,
        equity: subaccount ? subaccount.equity : undefined,
        mmrOther,
      });
    }

    const positionId = dto.positionId || `${dto.subaccountNumber}-${dto.marketId}`;

    const input = {
      userId: user.id,
      positionId,
      marketId: dto.marketId,
      subaccountNumber: dto.subaccountNumber,
      side: dto.side,
      size: sizeDecimal,
      entryPrice: entryPriceDecimal,
      liquidationPrice,
      oraclePrice,
      margin: marginDecimal,
    };

    return this.positionsService.upsertPosition(input);
  }

  @Put(':walletAddress/positions/:positionId')
  async updatePosition(
    @Param('walletAddress', WalletAddressValidationPipe) walletAddress: string,
    @Param('positionId') positionId: string,
    @Body() dto: UpsertPositionDto,
  ) {
    const user = await this.usersService.getOrCreateUser(walletAddress);

    // Construct expected positionId from body and compare with URL parameter
    const expectedPositionId = dto.positionId || `${dto.subaccountNumber}-${dto.marketId}`;
    if (expectedPositionId !== positionId) {
      throw new BadRequestException(
        `Route positionId '${positionId}' does not match body parameters (positionId: ${dto.positionId}, subaccountNumber: ${dto.subaccountNumber}, marketId: ${dto.marketId})`,
      );
    }

    const sizeDecimal = new Decimal(dto.size);
    const entryPriceDecimal = new Decimal(dto.entryPrice);
    const marginDecimal = new Decimal(dto.margin);

    let liquidationPrice: Decimal;
    let oraclePrice: Decimal;

    if (dto.liquidationPrice !== undefined && dto.oraclePrice !== undefined) {
      liquidationPrice = new Decimal(dto.liquidationPrice);
      oraclePrice = new Decimal(dto.oraclePrice);
    } else {
      const [marketData, subaccount] = await Promise.all([
        this.dydxService.getMarketData(dto.marketId),
        this.dydxService.getParentSubaccount(walletAddress, dto.subaccountNumber),
      ]);

      if (!marketData) {
        throw new BadRequestException(`Market parameters not found for marketId: ${dto.marketId}`);
      }

      oraclePrice = marketData.oraclePrice;

      let mmrOther = new Decimal(0);
      if (dto.subaccountNumber < 128 && subaccount && subaccount.openPerpetualPositions) {
        const markets = await this.dydxService.getMarkets();
        for (const [mId, pos] of Object.entries(subaccount.openPerpetualPositions)) {
          if (mId === dto.marketId) continue;
          const marketConfig = markets[mId];
          if (marketConfig) {
            const posSize = new Decimal((pos as any).size || 0).abs();
            const oPrice = new Decimal(marketConfig.oraclePrice || 0);
            const mmf = new Decimal(marketConfig.maintenanceMarginFraction || 0.05);
            mmrOther = mmrOther.add(posSize.mul(oPrice).mul(mmf));
          }
        }
      }

      liquidationPrice = this.riskService.calculateLiquidationPrice({
        size: sizeDecimal,
        oraclePrice: marketData.oraclePrice,
        maintenanceMarginFraction: marketData.maintenanceMarginFraction,
        entryPrice: entryPriceDecimal,
        margin: marginDecimal,
        side: dto.side,
        equity: subaccount ? subaccount.equity : undefined,
        mmrOther,
      });
    }

    const input = {
      marketId: dto.marketId,
      subaccountNumber: dto.subaccountNumber,
      side: dto.side,
      size: sizeDecimal,
      entryPrice: entryPriceDecimal,
      liquidationPrice,
      oraclePrice,
      margin: marginDecimal,
    };

    try {
      return await this.positionsService.updatePosition(user.id, positionId, input);
    } catch (error) {
      throw new NotFoundException(`Position ${positionId} for user ${walletAddress} not found`);
    }
  }

  @Delete(':walletAddress/positions/:positionId')
  async deleteUserPosition(
    @Param('walletAddress', WalletAddressValidationPipe) walletAddress: string,
    @Param('positionId') positionId: string,
  ) {
    const user = await this.usersService.getUserByWallet(walletAddress);
    if (!user) {
      throw new NotFoundException(`User with wallet ${walletAddress} not found`);
    }

    try {
      const result = await this.positionsService.markClosed(user.id, positionId);
      const parts = positionId.split('-');
      const subNum = parseInt(parts[0], 10) || 0;
      const marketId = parts.slice(1).join('-');

      await this.dydxDbService.deleteClosedPosition(walletAddress, subNum, marketId);
      await this.dydxLiqIndexService.remove(walletAddress, subNum, marketId);

      return result;
    } catch (error) {
      throw new NotFoundException(`Position ${positionId} for user ${walletAddress} not found`);
    }
  }
}
