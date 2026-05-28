import { IsNotEmpty, IsString } from 'class-validator';

export class UpdateTokenDto {
  @IsNotEmpty()
  @IsString()
  fcmToken: string;
}
