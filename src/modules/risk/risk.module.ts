import { Module } from '@nestjs/common';
import { RiskService } from './risk.service';

@Module({
  providers: [
    {
      provide: 'IRiskService',
      useClass: RiskService,
    },
  ],
  exports: ['IRiskService'],
})
export class RiskModule {}
