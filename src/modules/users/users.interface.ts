import { User } from '@prisma/client';

export interface IUsersService {
  registerUser(walletAddress: string, fcmToken: string): Promise<User>;
  updateFcmToken(walletAddress: string, fcmToken: string): Promise<User>;
  getUserByWallet(walletAddress: string): Promise<User | null>;
  getUserById(id: string): Promise<User | null>;
  getActiveUsers(): Promise<User[]>;
  clearFcmToken(userId: string): Promise<User>;
}
