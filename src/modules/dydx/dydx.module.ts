import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsModule } from '../notifications/notifications.module';

import { DydxFetcherService } from './dydx-fetcher.service';
import { DydxCalculatorService } from './dydx-calculator.service';
import { DydxAlertService } from './dydx-alert.service';
import { DydxDbService } from './dydx-db.service';
import { DydxLiquidationService } from './dydx-liquidation.service';

// Keep the old DydxService for backward compatibility with MonitorModule
import { DydxService } from './dydx.service';

@Module({
  imports: [ConfigModule, NotificationsModule],
  providers: [
    PrismaService,
    DydxFetcherService,
    DydxCalculatorService,
    DydxAlertService,
    DydxDbService,
    DydxLiquidationService,
    // Legacy provider for MonitorModule injection token
    {
      provide: 'IDydxService',
      useClass: DydxService,
    },
  ],
  exports: [
    'IDydxService',
    DydxFetcherService,
    DydxCalculatorService,
    DydxAlertService,
    DydxDbService,
    DydxLiquidationService,
  ],
})
export class DydxModule {}
