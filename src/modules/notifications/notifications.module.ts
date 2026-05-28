import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NotificationsService } from './notifications.service';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [ConfigModule, UsersModule],
  providers: [
    {
      provide: 'INotificationsService',
      useClass: NotificationsService,
    },
  ],
  exports: ['INotificationsService'],
})
export class NotificationsModule {}
