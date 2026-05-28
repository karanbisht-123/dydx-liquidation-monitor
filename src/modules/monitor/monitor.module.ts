import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ConfigModule } from '@nestjs/config';
import { MonitorScheduler } from './monitor.scheduler';
import { MonitorWorker } from './monitor.worker';
import { UsersModule } from '../users/users.module';
import { PositionsModule } from '../positions/positions.module';
import { DydxModule } from '../dydx/dydx.module';
import { RiskModule } from '../risk/risk.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaService } from '../../prisma/prisma.service';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    ConfigModule,
    UsersModule,
    PositionsModule,
    DydxModule,
    RiskModule,
    NotificationsModule,
  ],
  providers: [PrismaService, MonitorScheduler, MonitorWorker],
  exports: [MonitorScheduler],
})
export class MonitorModule {}
