import {
  BasePmsAdapter,
  type PaymentInfo,
  type OrderItem,
  type PaymentRequestResult,
} from "../pms-adapter-interface";
import {
  type ReservationUpsertedEvent,
  type RoomSyncEvent,
} from "../ingestion";
import { MewsClient } from "../mews-client";
import { MewsAdapter } from "../mews-adapter";

export class MewsPmsAdapter extends BasePmsAdapter {
  readonly pmsType = "mews" as const;
  private mewsAdapter: MewsAdapter;

  constructor(
    tenantId: string,
    private mewsClient: MewsClient
  ) {
    super(tenantId);
    this.mewsAdapter = new MewsAdapter(tenantId, mewsClient);
  }

  async fetchReservations(daysAhead: number): Promise<ReservationUpsertedEvent[]> {
    return this.mewsAdapter.fetchAndConvertReservations(daysAhead);
  }

  async fetchRooms(): Promise<RoomSyncEvent> {
    return this.mewsAdapter.fetchAndConvertRooms();
  }

  async getPayments(reservationPmsId: string): Promise<PaymentInfo[]> {
    const mewsPayments = await this.mewsClient.getPayments([reservationPmsId]);
    return mewsPayments.map(p => ({
      id: p.Id,
      amount: p.Amount?.GrossValue || 0,
      currency: p.Amount?.Currency || "EUR",
      state: this.mapMewsPaymentState(p.State),
      createdAt: p.CreatedUtc || new Date().toISOString(),
    }));
  }

  private mapMewsPaymentState(state: string): PaymentInfo["state"] {
    switch (state) {
      case "Charged": return "Charged";
      case "Canceled": return "Canceled";
      case "Failed": return "Failed";
      default: return "Pending";
    }
  }

  async getOrderItems(reservationPmsId: string): Promise<OrderItem[]> {
    const mewsItems = await this.mewsClient.getOrderItems([reservationPmsId]);
    return mewsItems.map(item => ({
      id: item.Id,
      amount: item.Amount.GrossValue,
      currency: item.Amount.Currency,
    }));
  }

  async createPaymentRequest(
    customerId: string,
    amount: number,
    currency: string,
    reservationPmsId: string,
    description: string,
    expirationDate: string
  ): Promise<PaymentRequestResult> {
    try {
      await this.mewsClient.createPaymentRequest(
        customerId,
        amount,
        currency,
        reservationPmsId,
        description,
        expirationDate
      );
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
