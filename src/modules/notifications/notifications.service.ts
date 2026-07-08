import * as admin from 'firebase-admin';
import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { INotificationsService, LiquidationAlertPayload } from './notifications.interface';
import { IUsersService } from '../users/users.interface';

@Injectable()
export class NotificationsService implements INotificationsService, OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name);
  private firebaseApp: admin.app.App | null = null;

  constructor(
    private readonly configService: ConfigService,
    @Inject('IUsersService')
    private readonly usersService: IUsersService,
    @Inject('REDIS_CLIENT')
    private readonly redis: Redis,
  ) { }

  onModuleInit(): void {
    const projectId = this.configService.get<string>('firebase.projectId');
    const clientEmail = this.configService.get<string>('firebase.clientEmail');
    let privateKey = this.configService.get<string>('firebase.privateKey');

    if (privateKey) {
      // Clean up stringified escape characters
      privateKey = privateKey.replace(/\\n/g, '\n');
    }

    try {
      this.firebaseApp = admin.initializeApp({
        credential: admin.credential.cert({
          projectId,
          clientEmail,
          privateKey,
        }),
      });
      this.logger.log('Firebase Admin SDK initialized successfully');
    } catch (error: any) {
      this.logger.error(`Failed to initialize Firebase Admin: ${error.message}`);
    }
  }

  private getCooldownTtl(alertType: string): number {
    switch (alertType) {
      case 'CRITICAL':
        return 3600;
      case 'DANGER':
        return 14400;
      case 'WARNING':
        return 43200;
      default:
        return 21600;
    }
  }

  async sendLiquidationAlert(fcmToken: string, payload: LiquidationAlertPayload): Promise<void> {
    const isEnabled = this.configService.get<boolean>('notifications.enabled', true);
    if (!isEnabled) {
      return;
    }

    const user = await this.usersService.getUserById(payload.userId);
    if (!user || !user.isActive) {
      return;
    }

    if (payload.alertType === 'WARNING') {
      const globalKey = `cooldown:notification:user-global:${payload.userId}`;
      const globalSet = await this.redis.set(globalKey, '1', 'EX', 300, 'NX');
      if (globalSet !== 'OK') {
        return;
      }
    }

    const cooldownKey = `cooldown:notification:${payload.userId}:${payload.positionId}:${payload.alertType}`;
    const ttl = this.getCooldownTtl(payload.alertType);
    const cooldownSet = await this.redis.set(cooldownKey, '1', 'EX', ttl, 'NX');
    if (cooldownSet !== 'OK') {
      return;
    }

    const marginTypeText = payload.marginType || 'CROSS';
    const alertMessage = {
      title: `⚠️ Liquidation Risk [${marginTypeText}] — ${payload.marketId}`,
      body: `${payload.side} (${marginTypeText}) is ${payload.distancePct}% from liquidation. Oracle: $${payload.oraclePrice} | Liq: $${payload.liquidationPrice}`,
      data: {
        positionId: payload.positionId,
        marketId: payload.marketId,
        alertType: payload.alertType,
        distancePct: String(payload.distancePct),
        liquidationPrice: String(payload.liquidationPrice),
        oraclePrice: String(payload.oraclePrice),
        marginType: marginTypeText,
      }
    };

    if (!this.firebaseApp) {
      this.logger.warn('Skipping actual Firebase FCM transmission (Firebase Admin SDK not initialized).');
      return;
    }

    const message = {
      token: fcmToken,
      notification: {
        title: alertMessage.title,
        body: alertMessage.body,
      },
      data: alertMessage.data,
      android: {
        priority: 'high' as const,
      },
      apns: {
        payload: {
          aps: {
            sound: 'default',
            badge: 1,
          },
        },
      },
    };

    this.logger.log(`Sending push notification to Firebase FCM for user ${payload.userId}...`);
    admin.messaging().send(message)
      .then(() => {
        this.logger.log(`Notification sent successfully via Firebase FCM to user ${payload.userId}`);
      })
      .catch(async (error: any) => {
        this.logger.error(`Firebase FCM error sending alert: ${error.message}`);
        if (error.code === 'messaging/registration-token-not-registered') {
          this.logger.warn(`FCM token expired for user ${payload.userId}. Clearing in DB.`);
          try {
            await this.usersService.clearFcmToken(payload.userId);
          } catch (dbError: any) {
            this.logger.error(`Failed to clear expired FCM token in DB for user ${payload.userId}: ${dbError.message}`);
          }
        }
      });
  }
}
