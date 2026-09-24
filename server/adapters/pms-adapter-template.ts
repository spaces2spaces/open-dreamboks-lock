import { randomUUID } from "crypto";
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

export class TemplateAdapter extends BasePmsAdapter {
  readonly pmsType = "other" as const;

  constructor(
    tenantId: string,
    private config: {
      apiUrl: string;
      apiKey: string;
      hotelId: string;
    }
  ) {
    super(tenantId);
  }

  async fetchReservations(daysAhead: number): Promise<ReservationUpsertedEvent[]> {
    const events: ReservationUpsertedEvent[] = [];

    return events;
  }

  async fetchRooms(): Promise<RoomSyncEvent> {
    return {
      eventType: "room.sync",
      eventId: randomUUID(),
      timestamp: new Date().toISOString(),
      tenantId: this.tenantId,
      pmsType: this.pmsType,
      data: {
        rooms: [],
      },
    };
  }

  async getPayments(reservationPmsId: string): Promise<PaymentInfo[]> {
    return [];
  }

  async getOrderItems(reservationPmsId: string): Promise<OrderItem[]> {
    return [];
  }

  async createPaymentRequest(
    customerId: string,
    amount: number,
    currency: string,
    reservationPmsId: string,
    description: string,
    expirationDate: string
  ): Promise<PaymentRequestResult> {
    return {
      success: false,
      error: "Payment requests not implemented for this PMS",
    };
  }
}
