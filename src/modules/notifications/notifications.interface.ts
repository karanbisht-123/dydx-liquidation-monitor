export interface LiquidationAlertPayload {
  userId: string;
  positionId: string;
  marketId: string;
  side: 'LONG' | 'SHORT';
  distancePct: string;
  liquidationPrice: string;
  oraclePrice: string;
  alertType: string;
  marginType?: 'CROSS' | 'ISOLATED';
}

export interface INotificationsService {
  sendLiquidationAlert(fcmToken: string, payload: LiquidationAlertPayload): Promise<void>;
}
