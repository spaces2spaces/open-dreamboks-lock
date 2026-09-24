import { MewsClient, type MewsReservationsData } from "./mews-client.js";
import { IngestionClient, type ReservationUpsertedEvent, type NormalizedReservation } from "./ingestion-client.js";

interface PollResult {
  success: boolean;
  eventsCount: number;
  error?: string;
}

type PollCallback = (result: PollResult) => void;

function mapMewsStatusToNormalized(state: string): "Confirmed" | "CheckedIn" | "CheckedOut" | "Cancelled" {
  switch (state) {
    case "Confirmed":
      return "Confirmed";
    case "Started":
      return "CheckedIn";
    case "Processed":
      return "CheckedOut";
    case "Canceled":
      return "Cancelled";
    default:
      return "Confirmed";
  }
}

export class MewsPoller {
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;
  private callbacks: PollCallback[] = [];

  constructor(
    private mewsClient: MewsClient,
    private ingestionClient: IngestionClient,
    private pollIntervalMs: number = 60000
  ) {}

  onPollComplete(callback: PollCallback) {
    this.callbacks.push(callback);
  }

  private notifyCallbacks(result: PollResult) {
    this.callbacks.forEach(cb => cb(result));
  }

  async start() {
    if (this.isRunning) {
      console.log("Poller already running");
      return;
    }

    this.isRunning = true;
    console.log(`MEWS Poller started - polling every ${this.pollIntervalMs / 1000}s`);

    await this.poll();

    this.intervalId = setInterval(async () => {
      await this.poll();
    }, this.pollIntervalMs);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      this.isRunning = false;
      console.log("MEWS Poller stopped");
    }
  }

  async pollNow() {
    await this.poll();
  }

  private async poll() {
    try {
      console.log("Polling MEWS for reservations...");
      const mewsData = await this.mewsClient.getActiveReservations();
      const events = this.convertToEvents(mewsData);
      
      console.log(`Found ${events.length} reservations to sync`);

      if (events.length > 0) {
        const response = await this.ingestionClient.sendEvents(events);
        console.log(`Sent ${events.length} events, processed: ${response.processed}`);
      }

      this.notifyCallbacks({
        success: true,
        eventsCount: events.length,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("Poll error:", message);
      this.notifyCallbacks({
        success: false,
        eventsCount: 0,
        error: message,
      });
    }
  }

  private convertToEvents(mewsData: MewsReservationsData): ReservationUpsertedEvent[] {
    const reservations = mewsData.Reservations || [];
    const customerMap = new Map(mewsData.Customers.map(c => [c.Id, c]));
    const resourceMap = new Map(mewsData.Resources.map(r => [r.Id, r]));
    const reservationGroupMap = new Map((mewsData.ReservationGroups || []).map(g => [g.Id, g]));
    const resourceCategoryMap = new Map((mewsData.ResourceCategories || []).map(rc => [rc.Id, rc]));
    const rateMap = new Map((mewsData.Rates || []).map(r => [r.Id, r]));

    const orderItemsByReservation = new Map<string, typeof mewsData.OrderItems>();
    for (const item of mewsData.OrderItems) {
      if (!orderItemsByReservation.has(item.ServiceOrderId)) {
        orderItemsByReservation.set(item.ServiceOrderId, []);
      }
      orderItemsByReservation.get(item.ServiceOrderId)!.push(item);
    }

    const events: ReservationUpsertedEvent[] = [];

    for (const mewsRes of reservations) {
      const customer = customerMap.get(mewsRes.CustomerId);
      const resource = mewsRes.AssignedResourceId ? resourceMap.get(mewsRes.AssignedResourceId) : null;
      const group = mewsRes.GroupId ? reservationGroupMap.get(mewsRes.GroupId) : null;
      const category = mewsRes.RequestedResourceCategoryId 
        ? resourceCategoryMap.get(mewsRes.RequestedResourceCategoryId) 
        : null;
      const rate = mewsRes.RateId ? rateMap.get(mewsRes.RateId) : null;

      const items = orderItemsByReservation.get(mewsRes.Id) || [];
      const totalAmount = items.reduce((sum, item) => sum + item.Amount.GrossValue, 0);
      const currency = items.length > 0 ? items[0].Amount.Currency : null;
      const avgRate = items.length > 0 ? (totalAmount / items.length).toFixed(2) : null;

      const normalized: NormalizedReservation = {
        pmsReservationId: mewsRes.Id,
        confirmationNumber: mewsRes.ChannelNumber || mewsRes.Number || null,
        status: mapMewsStatusToNormalized(mewsRes.State),
        arrival: new Date(mewsRes.ScheduledStartUtc || mewsRes.StartUtc).toISOString(),
        departure: new Date(mewsRes.ScheduledEndUtc || mewsRes.EndUtc).toISOString(),
        guest: {
          firstName: customer?.FirstName || "Unknown",
          lastName: customer?.LastName || "Guest",
          email: customer?.Email || null,
          mobile: customer?.Phone || null,
        },
        roomPmsId: mewsRes.AssignedResourceId || null,
        roomName: resource?.Name || null,
        bedName: null,
        adults: mewsRes.AdultCount || 1,
        children: mewsRes.ChildCount || 0,
        groupName: group?.Name || null,
        requestedCategory: category?.Name || null,
        spaceCategory: category?.Name || null,
        rateName: rate?.Name || null,
        avgRate,
        totalAmount: totalAmount > 0 ? totalAmount.toFixed(2) : null,
        currency,
        owing: null,
        origin: mewsRes.Origin || null,
        reservationSource: mewsRes.OriginDetails || null,
      };

      events.push(this.ingestionClient.createEvent(normalized));
    }

    return events;
  }
}
