import * as admin from 'firebase-admin';
import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
  ) {}

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

  async sendLiquidationAlert(fcmToken: string, payload: LiquidationAlertPayload): Promise<void> {
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

    // Beautifully format and output the simulated push alert to the console
    this.logger.warn(
      `\n======================================================================\n` +
      `📢 [SIMULATED PUSH NOTIFICATION SENT]\n` +
      `To Token: ${fcmToken}\n` +
      `Title:    ${alertMessage.title}\n` +
      `Body:     ${alertMessage.body}\n` +
      `Data:     ${JSON.stringify(alertMessage.data, null, 2)}\n` +
      `======================================================================`
    );

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

    try {
      this.logger.log(`Sending push notification to Firebase FCM for user ${payload.userId}...`);
      await admin.messaging().send(message);
      this.logger.log(`Notification sent successfully via Firebase FCM to user ${payload.userId}`);
    } catch (error: any) {
      this.logger.error(`Firebase FCM error sending alert: ${error.message}`);
      if (error.code === 'messaging/registration-token-not-registered') {
        this.logger.warn(`FCM token expired for user ${payload.userId}. Clearing in DB.`);
        try {
          await this.usersService.clearFcmToken(payload.userId);
        } catch (dbError: any) {
          this.logger.error(`Failed to clear expired FCM token in DB for user ${payload.userId}: ${dbError.message}`);
        }
      }
    }
  }
}
