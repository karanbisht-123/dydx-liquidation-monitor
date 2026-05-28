import { Controller, Post, Patch, Body, Param, NotFoundException, Inject } from '@nestjs/common';
import { RegisterUserDto } from './dto/register-user.dto';
import { UpdateTokenDto } from './dto/update-token.dto';
import { IUsersService } from './users.interface';

@Controller('users')
export class UsersController {
  constructor(
    @Inject('IUsersService')
    private readonly usersService: IUsersService,
  ) {}

  @Post('register')
  async register(@Body() dto: RegisterUserDto): Promise<{ id: string; walletAddress: string; createdAt: Date }> {
    const user = await this.usersService.registerUser(dto.walletAddress, dto.fcmToken);
    return {
      id: user.id,
      walletAddress: user.walletAddress,
      createdAt: user.createdAt,
    };
  }

  @Patch(':walletAddress/token')
  async updateToken(
    @Param('walletAddress') walletAddress: string,
    @Body() dto: UpdateTokenDto,
  ): Promise<{ success: boolean }> {
    const user = await this.usersService.getUserByWallet(walletAddress);
    if (!user) {
      throw new NotFoundException(`User with wallet ${walletAddress} not found`);
    }
    await this.usersService.updateFcmToken(walletAddress, dto.fcmToken);
    return { success: true };
  }
}
