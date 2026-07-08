import { IsNotEmpty, IsString, Matches } from 'class-validator';

export class RegisterUserDto {
  @IsNotEmpty()
  @IsString()
  @Matches(/^(dydx1[a-z0-9]{38}|0x[a-fA-F0-9]{40})$/i, {
    message: 'Invalid wallet address format. Must be a valid dYdX (dydx1...) or EVM (0x...) address.',
  })
  walletAddress: string;

  @IsNotEmpty()
  @IsString()
  fcmToken: string;
}
