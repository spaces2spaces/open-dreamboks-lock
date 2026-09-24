import { 
  type ReservationUpsertedEvent,
  type RoomSyncEvent,
} from "./ingestion";

export interface PaymentInfo {
  id: string;
  amount: number;
  currency: string;
  state: "Pending" | "Charged" | "Canceled" | "Failed";
  createdAt: string;
}

export interface OrderItem {
  id: string;
  amount: number;
  currency: string;
  description?: string;
}

export interface PaymentRequestResult {
  success: boolean;
  paymentRequestId?: string;
  paymentUrl?: string;
  error?: string;
}

export interface PmsAdapterInterface {
  readonly pmsType: "mews" | "opera" | "protel" | "cloudbeds" | "other";
  readonly tenantId: string;

  fetchReservations(daysAhead: number): Promise<ReservationUpsertedEvent[]>;

  fetchRooms(): Promise<RoomSyncEvent>;

  getPayments(reservationPmsId: string): Promise<PaymentInfo[]>;

  getOrderItems(reservationPmsId: string): Promise<OrderItem[]>;

  isPaymentComplete(payments: PaymentInfo[]): boolean;

  createPaymentRequest(
    customerId: string,
    amount: number,
    currency: string,
    reservationPmsId: string,
    description: string,
    expirationDate: string
  ): Promise<PaymentRequestResult>;

  calculateOutstandingBalance(reservationPmsId: string): Promise<{
    totalAmount: number;
    paidAmount: number;
    owing: number;
    currency: string;
  }>;
}

export abstract class BasePmsAdapter implements PmsAdapterInterface {
  abstract readonly pmsType: "mews" | "opera" | "protel" | "cloudbeds" | "other";
  
  constructor(public readonly tenantId: string) {}

  abstract fetchReservations(daysAhead: number): Promise<ReservationUpsertedEvent[]>;
  abstract fetchRooms(): Promise<RoomSyncEvent>;
  abstract getPayments(reservationPmsId: string): Promise<PaymentInfo[]>;
  abstract getOrderItems(reservationPmsId: string): Promise<OrderItem[]>;
  abstract createPaymentRequest(
    customerId: string,
    amount: number,
    currency: string,
    reservationPmsId: string,
    description: string,
    expirationDate: string
  ): Promise<PaymentRequestResult>;

  isPaymentComplete(payments: PaymentInfo[]): boolean {
    return payments.some(payment => payment.state === "Charged");
  }

  async calculateOutstandingBalance(reservationPmsId: string): Promise<{
    totalAmount: number;
    paidAmount: number;
    owing: number;
    currency: string;
  }> {
    const [orderItems, payments] = await Promise.all([
      this.getOrderItems(reservationPmsId),
      this.getPayments(reservationPmsId),
    ]);

    const totalAmount = orderItems.reduce((sum, item) => sum + item.amount, 0);
    const paidAmount = payments
      .filter(p => p.state === "Charged")
      .reduce((sum, p) => sum + p.amount, 0);
    const owing = Math.max(0, totalAmount - paidAmount);
    const currency = orderItems[0]?.currency || payments[0]?.currency || "EUR";

    return { totalAmount, paidAmount, owing, currency };
  }
}
