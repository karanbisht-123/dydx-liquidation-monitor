import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { User } from '@prisma/client';
import { IUsersService } from './users.interface';

@Injectable()
export class UsersService implements IUsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(private readonly prisma: PrismaService) {}

  async registerUser(walletAddress: string, fcmToken: string): Promise<User> {
    const normalizedWallet = walletAddress.toLowerCase();
    this.logger.log(`Registering user with wallet: ${normalizedWallet}`);
    return this.prisma.user.upsert({
      where: { walletAddress: normalizedWallet },
      update: { fcmToken, isActive: true },
      create: { walletAddress: normalizedWallet, fcmToken, isActive: true },
    });
  }

  async updateFcmToken(walletAddress: string, fcmToken: string): Promise<User> {
    const normalizedWallet = walletAddress.toLowerCase();
    this.logger.log(`Updating FCM token for wallet: ${normalizedWallet}`);
    return this.prisma.user.update({
      where: { walletAddress: normalizedWallet },
      data: { fcmToken },
    });
  }

  async getUserByWallet(walletAddress: string): Promise<User | null> {
    const normalizedWallet = walletAddress.toLowerCase();
    return this.prisma.user.findUnique({
      where: { walletAddress: normalizedWallet },
    });
  }

  async getUserById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { id },
    });
  }

  async getActiveUsers(): Promise<User[]> {
    return this.prisma.user.findMany({
      where: {
        isActive: true,
        fcmToken: { not: null },
      },
    });
  }

  async clearFcmToken(userId: string): Promise<User> {
    this.logger.log(`Clearing FCM token for user ID or address: ${userId}`);
    if (userId.startsWith('dydx1')) {
      const normalizedWallet = userId.toLowerCase();
      return this.prisma.user.update({
        where: { walletAddress: normalizedWallet },
        data: { fcmToken: null },
      });
    }
    return this.prisma.user.update({
      where: { id: userId },
      data: { fcmToken: null },
    });
  }
}
