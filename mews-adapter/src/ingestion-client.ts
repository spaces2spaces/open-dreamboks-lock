import { createHmac } from "crypto";

export interface NormalizedReservation {
  pmsReservationId: string;
  confirmationNumber: string | null;
  status: "Confirmed" | "CheckedIn" | "CheckedOut" | "Cancelled";
  arrival: string;
  departure: string;
  guest: {
    firstName: string;
    lastName: string;
    email: string | null;
    mobile: string | null;
  };
  roomPmsId: string | null;
  roomName: string | null;
  bedName: string | null;
  adults: number;
  children: number;
  groupName: string | null;
  requestedCategory: string | null;
  spaceCategory: string | null;
  rateName: string | null;
  avgRate: string | null;
  totalAmount: string | null;
  currency: string | null;
  owing: string | null;
  origin: string | null;
  reservationSource: string | null;
}

export interface ReservationUpsertedEvent {
  eventType: "reservation.upserted";
  eventId: string;
  timestamp: string;
  tenantId: string;
  pmsType: "mews";
  data: NormalizedReservation;
}

export interface IngestionRequest {
  idempotencyKey: string;
  events: ReservationUpsertedEvent[];
}

export interface IngestionResponse {
  success: boolean;
  processed: number;
  errors?: string[];
}

export class IngestionClient {
  constructor(
    private coreBaseUrl: string,
    private tenantId: string,
    private webhookSecret: string
  ) {}

  async sendEvents(events: ReservationUpsertedEvent[]): Promise<IngestionResponse> {
    if (events.length === 0) {
      return { success: true, processed: 0 };
    }

    const idempotencyKey = crypto.randomUUID();
    const request: IngestionRequest = {
      idempotencyKey,
      events,
    };

    const body = JSON.stringify(request);
    const timestamp = Date.now().toString();
    const signature = this.createSignature(body, timestamp);

    const response = await fetch(`${this.coreBaseUrl}/api/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-dreamboks-signature": signature,
        "x-dreamboks-timestamp": timestamp,
      },
      body,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ingestion failed ${response.status}: ${errorText}`);
    }

    return response.json();
  }

  private createSignature(body: string, timestamp: string): string {
    const payload = `${timestamp}.${body}`;
    return createHmac("sha256", this.webhookSecret)
      .update(payload)
      .digest("hex");
  }

  createEvent(reservation: NormalizedReservation): ReservationUpsertedEvent {
    return {
      eventType: "reservation.upserted",
      eventId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      tenantId: this.tenantId,
      pmsType: "mews",
      data: reservation,
    };
  }
}
