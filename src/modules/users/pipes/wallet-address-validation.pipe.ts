import { PipeTransform, Injectable, BadRequestException } from '@nestjs/common';

@Injectable()
export class WalletAddressValidationPipe implements PipeTransform<string, string> {
  private readonly dydxRegex = /^dydx1[a-z0-9]{38}$/i;
  private readonly evmRegex = /^0x[a-fA-F0-9]{40}$/;

  transform(value: string): string {
    if (!value) {
      throw new BadRequestException('Wallet address is required');
    }

    const trimmed = value.trim();
    const isValidDydx = this.dydxRegex.test(trimmed);
    const isValidEvm = this.evmRegex.test(trimmed);

    if (!isValidDydx && !isValidEvm) {
      throw new BadRequestException(
        'Invalid wallet address format. Must be a valid dYdX address (dydx1...) or Ethereum address (0x...).',
      );
    }

    return trimmed;
  }
}
