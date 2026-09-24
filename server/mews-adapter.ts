import { MewsClient } from "./mews-client";
import { 
  type NormalizedReservation,
  type ReservationUpsertedEvent,
  type RoomSyncEvent,
  mapMewsStatusToNormalized,
} from "./ingestion";

interface MewsReservation {
  Id: string;
  State: "Canceled" | "Confirmed" | "Started" | "Processed";
  StartUtc: string;
  EndUtc: string;
  ScheduledStartUtc: string;
  ScheduledEndUtc: string;
  CustomerId: string;
  AssignedResourceId?: string;
  Number?: string;
  AdultCount?: number;
  ChildCount?: number;
  GroupId?: string;
  RequestedResourceCategoryId?: string;
  RateId?: string;
  Origin?: string;
  OriginDetails?: string;
  ChannelNumber?: string;
  ChannelManagerNumber?: string;
}

interface MewsCustomer {
  Id: string;
  FirstName?: string;
  LastName?: string;
  Email?: string;
  Phone?: string;
}

interface MewsResource {
  Id: string;
  Name: string;
  State: string;
}

interface MewsReservationGroup {
  Id: string;
  Name?: string;
}

interface MewsResourceCategory {
  Id: string;
  Name: string;
}

interface MewsRate {
  Id: string;
  Name: string;
}

interface MewsOrderItem {
  Id: string;
  ServiceOrderId: string;
  Amount: {
    Currency: string;
    GrossValue: number;
  };
}

export interface MewsReservationsData {
  Reservations: MewsReservation[];
  ReservationGroups?: MewsReservationGroup[];
  ResourceCategories?: MewsResourceCategory[];
  Rates?: MewsRate[];
}

export class MewsAdapter {
  constructor(
    private tenantId: string,
    private mewsClient: MewsClient
  ) {}

  async fetchAndConvertReservations(daysAhead: number = 1): Promise<ReservationUpsertedEvent[]> {
    // In-house guests may have extended stays beyond the arrivals window,
    // so always fetch them with a generous horizon (30 days) regardless of daysAhead.
    const inHouseDaysAhead = Math.max(daysAhead, 30);
    const [arrivalData, inHouseData] = await Promise.all([
      this.mewsClient.getActiveReservations(daysAhead, 1),
      this.mewsClient.getInHouseReservations(inHouseDaysAhead)
    ]);
    
    const arrivalReservations = arrivalData.Reservations || [];
    const inHouseReservations = inHouseData.Reservations || [];
    
    const reservationMap = new Map<string, typeof arrivalReservations[0]>();
    for (const res of arrivalReservations) {
      reservationMap.set(res.Id, res);
    }
    for (const res of inHouseReservations) {
      if (!reservationMap.has(res.Id)) {
        reservationMap.set(res.Id, res);
      }
    }
    const mewsReservations = Array.from(reservationMap.values());
    
    const mewsData = {
      Reservations: mewsReservations,
      ReservationGroups: [...(arrivalData.ReservationGroups || []), ...(inHouseData.ReservationGroups || [])],
      ResourceCategories: [...(arrivalData.ResourceCategories || []), ...(inHouseData.ResourceCategories || [])],
      Rates: [...(arrivalData.Rates || []), ...(inHouseData.Rates || [])]
    };

    if (mewsReservations.length === 0) {
      return [];
    }

    const BATCH_SIZE = 500;

    const customerIds = Array.from(new Set(mewsReservations.map(r => r.CustomerId)));
    const customerMap = new Map<string, MewsCustomer>();
    
    for (let i = 0; i < customerIds.length; i += BATCH_SIZE) {
      const batch = customerIds.slice(i, i + BATCH_SIZE);
      const batchCustomers = await this.mewsClient.getCustomers(batch);
      for (const c of batchCustomers) {
        customerMap.set(c.Id, c);
      }
    }

    const reservationGroupMap = new Map((mewsData.ReservationGroups || []).map(g => [g.Id, g]));
    const resourceCategoryMap = new Map((mewsData.ResourceCategories || []).map(rc => [rc.Id, rc]));
    const rateMap = new Map((mewsData.Rates || []).map(r => [r.Id, r]));

    const reservationIds = mewsReservations.map(r => r.Id);
    const orderItemsByReservation = new Map<string, MewsOrderItem[]>();

    for (let i = 0; i < reservationIds.length; i += BATCH_SIZE) {
      const batch = reservationIds.slice(i, i + BATCH_SIZE);
      const batchItems = await this.mewsClient.getOrderItems(batch);
      for (const item of batchItems) {
        if (!orderItemsByReservation.has(item.ServiceOrderId)) {
          orderItemsByReservation.set(item.ServiceOrderId, []);
        }
        orderItemsByReservation.get(item.ServiceOrderId)!.push(item);
      }
    }

    // Fetch open bill balances per customer in one API call.
    // This correctly reflects billing automation (e.g. OTA bookings where
    // charges move to a company bill → customer balance = 0).
    // Returns empty map on API error; in that case owing stays null (DB value preserved).
    const billBalanceMap = await this.mewsClient.getBillBalancesForCustomers(customerIds);

    const resourceIds = Array.from(
      new Set(mewsReservations.map(r => r.AssignedResourceId).filter(Boolean))
    ) as string[];
    const resources = resourceIds.length > 0 ? await this.mewsClient.getResources(resourceIds) : [];
    const resourceMap = new Map(resources.map(r => [r.Id, r]));

    return this.convertMewsReservations(
      mewsReservations,
      customerMap,
      reservationGroupMap,
      resourceCategoryMap,
      rateMap,
      orderItemsByReservation,
      billBalanceMap,
      resourceMap
    );
  }

  private convertMewsReservations(
    mewsReservations: MewsReservation[],
    customerMap: Map<string, MewsCustomer>,
    reservationGroupMap: Map<string, MewsReservationGroup>,
    resourceCategoryMap: Map<string, MewsResourceCategory>,
    rateMap: Map<string, MewsRate>,
    orderItemsByReservation: Map<string, MewsOrderItem[]>,
    billBalanceMap: Map<string, number>,
    resourceMap: Map<string, MewsResource>
  ): ReservationUpsertedEvent[] {
    const events: ReservationUpsertedEvent[] = [];
    const timestamp = new Date().toISOString();

    for (const mewsRes of mewsReservations) {
      const customer = customerMap.get(mewsRes.CustomerId);
      const reservationGroup = mewsRes.GroupId ? reservationGroupMap.get(mewsRes.GroupId) : null;
      const requestedCategory = mewsRes.RequestedResourceCategoryId
        ? resourceCategoryMap.get(mewsRes.RequestedResourceCategoryId)
        : null;
      const assignedResource = mewsRes.AssignedResourceId
        ? resourceMap.get(mewsRes.AssignedResourceId)
        : null;
      const rate = mewsRes.RateId ? rateMap.get(mewsRes.RateId) : null;

      const items = orderItemsByReservation.get(mewsRes.Id) || [];
      const totalAmount = items.reduce((sum, item) => sum + item.Amount.GrossValue, 0);
      const currency = items.length > 0 ? items[0].Amount.Currency : null;
      const avgRate = items.length > 0 ? (totalAmount / items.length).toFixed(2) : null;

      const normalizedReservation: NormalizedReservation = {
        pmsReservationId: mewsRes.Id,
        confirmationNumber: mewsRes.Number || null,
        channelNumber: mewsRes.ChannelNumber || null,
        channelManagerNumber: mewsRes.ChannelManagerNumber || null,
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
        roomName: assignedResource?.Name || null,
        bedName: null,
        adults: mewsRes.AdultCount || 1,
        children: mewsRes.ChildCount || 0,
        groupName: reservationGroup?.Name || null,
        requestedCategory: requestedCategory?.Name || null,
        spaceCategory: requestedCategory?.Name || null,
        rateName: rate?.Name || null,
        avgRate: avgRate,
        totalAmount: totalAmount > 0 ? totalAmount.toFixed(2) : null,
        currency: currency,
        owing: billBalanceMap.size > 0
          ? (billBalanceMap.get(mewsRes.CustomerId) ?? 0).toFixed(2)
          : null,
        origin: mewsRes.Origin || null,
        reservationSource: mewsRes.OriginDetails || null,
        pmsCustomerId: mewsRes.CustomerId || null,
      };

      events.push({
        eventType: "reservation.upserted",
        eventId: randomUUID(),
        timestamp,
        tenantId: this.tenantId,
        pmsType: "mews",
        data: normalizedReservation,
      });
    }

    return events;
  }

  /**
   * Fetch a single reservation by PMS ID and convert it to a normalized upsert event.
   * Used by the drift reconciler to re-ingest a specific reservation whose state has
   * diverged from MEWS. Returns null if the reservation is not found.
   */
  async fetchAndConvertSingleReservation(
    pmsId: string
  ): Promise<ReservationUpsertedEvent | null> {
    const mewsReservations = await this.mewsClient.getReservations([pmsId]);
    if (mewsReservations.length === 0) return null;

    const mewsRes = mewsReservations[0];

    const customers = await this.mewsClient.getCustomers([mewsRes.CustomerId]);
    const customerMap = new Map<string, any>();
    for (const c of customers) customerMap.set(c.Id, c);

    const orderItemsByReservation = new Map<string, any[]>();
    try {
      const items = await this.mewsClient.getOrderItems([mewsRes.Id]);
      for (const item of items) {
        if (!orderItemsByReservation.has(item.ServiceOrderId)) {
          orderItemsByReservation.set(item.ServiceOrderId, []);
        }
        orderItemsByReservation.get(item.ServiceOrderId)!.push(item);
      }
    } catch {
      /* non-fatal — owing stays null */
    }

    const billBalanceMap = await this.mewsClient
      .getBillBalancesForCustomers([mewsRes.CustomerId])
      .catch(() => new Map<string, number>());

    const resourceMap = new Map<string, MewsResource>();
    if (mewsRes.AssignedResourceId) {
      try {
        const resources = await this.mewsClient.getResources([mewsRes.AssignedResourceId]);
        for (const r of resources) resourceMap.set(r.Id, r);
      } catch {
        /* non-fatal */
      }
    }

    const events = this.convertMewsReservations(
      [mewsRes],
      customerMap,
      new Map(),
      new Map(),
      new Map(),
      orderItemsByReservation,
      billBalanceMap,
      resourceMap
    );

    return events[0] || null;
  }

  async fetchAndConvertUpdatedReservations(sinceUtc: Date): Promise<ReservationUpsertedEvent[]> {
    const data = await this.mewsClient.getUpdatedReservations(sinceUtc);
    const mewsReservations = data.Reservations || [];
    if (mewsReservations.length === 0) return [];

    // Reuse the same conversion pipeline as fetchAndConvertReservations
    // by temporarily building a mewsData object compatible with the converter
    const BATCH_SIZE = 500;
    const customerIds = Array.from(new Set(mewsReservations.map(r => r.CustomerId)));
    const customerMap = new Map<string, any>();
    for (let i = 0; i < customerIds.length; i += BATCH_SIZE) {
      const batch = customerIds.slice(i, i + BATCH_SIZE);
      const batchCustomers = await this.mewsClient.getCustomers(batch);
      for (const c of batchCustomers) customerMap.set(c.Id, c);
    }

    const reservationGroupMap = new Map((data.ReservationGroups || []).map((g: any) => [g.Id, g]));
    const resourceCategoryMap = new Map((data.ResourceCategories || []).map((rc: any) => [rc.Id, rc]));
    const rateMap = new Map((data.Rates || []).map((r: any) => [r.Id, r]));

    const reservationIds = mewsReservations.map(r => r.Id);
    const orderItemsByReservation = new Map<string, any[]>();
    for (let i = 0; i < reservationIds.length; i += BATCH_SIZE) {
      const batch = reservationIds.slice(i, i + BATCH_SIZE);
      const batchItems = await this.mewsClient.getOrderItems(batch);
      for (const item of batchItems) {
        if (!orderItemsByReservation.has(item.ServiceOrderId)) {
          orderItemsByReservation.set(item.ServiceOrderId, []);
        }
        orderItemsByReservation.get(item.ServiceOrderId)!.push(item);
      }
    }

    const billBalanceMap = await this.mewsClient.getBillBalancesForCustomers(customerIds);

    const resourceIds = Array.from(
      new Set(mewsReservations.map(r => r.AssignedResourceId).filter(Boolean))
    ) as string[];
    const resources = resourceIds.length > 0 ? await this.mewsClient.getResources(resourceIds) : [];
    const resourceMap = new Map(resources.map(r => [r.Id, r]));

    return this.convertMewsReservations(
      mewsReservations,
      customerMap,
      reservationGroupMap,
      resourceCategoryMap,
      rateMap,
      orderItemsByReservation,
      billBalanceMap,
      resourceMap
    );
  }

  async fetchAndConvertRooms(): Promise<RoomSyncEvent> {
    const resources = await this.mewsClient.getResources();
    
    return {
      eventType: "room.sync",
      eventId: randomUUID(),
      timestamp: new Date().toISOString(),
      tenantId: this.tenantId,
      pmsType: "mews",
      data: {
        rooms: resources.map((r: MewsResource) => ({
          pmsRoomId: r.Id,
          name: r.Name,
          category: null,
          state: r.State === "Active" ? "Active" as const : "Inactive" as const,
        })),
      },
    };
  }
}

function randomUUID(): string {
  return crypto.randomUUID();
}
