import { Module } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PositionsService } from './positions.service';
import { PositionsController } from './positions.controller';
import { UsersModule } from '../users/users.module';
import { RiskModule } from '../risk/risk.module';

@Module({
  imports: [UsersModule, RiskModule],
  controllers: [PositionsController],
  providers: [
    PrismaService,
    {
      provide: 'IPositionsService',
      useClass: PositionsService,
    },
  ],
  exports: ['IPositionsService'],
})
export class PositionsModule {}
