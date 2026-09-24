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

interface MewsResource {
  Id: string;
  Name: string;
  State: string;
}

interface MewsCustomer {
  Id: string;
  FirstName?: string;
  LastName?: string;
  Email?: string;
  Phone?: string;
}

interface MewsOrderItem {
  Id: string;
  ServiceOrderId: string;
  Amount: {
    Currency: string;
    GrossValue: number;
  };
}

interface MewsReservationsResponse {
  Reservations: MewsReservation[];
  ReservationGroups?: MewsReservationGroup[];
  ResourceCategories?: MewsResourceCategory[];
  Rates?: MewsRate[];
}

interface MewsResourcesResponse {
  Resources: MewsResource[];
}

interface MewsCustomersResponse {
  Customers: MewsCustomer[];
}

interface MewsOrderItemsResponse {
  OrderItems: MewsOrderItem[];
}

export interface MewsReservationsData {
  Reservations: MewsReservation[];
  ReservationGroups?: MewsReservationGroup[];
  ResourceCategories?: MewsResourceCategory[];
  Rates?: MewsRate[];
  Customers: MewsCustomer[];
  Resources: MewsResource[];
  OrderItems: MewsOrderItem[];
}

export class MewsClient {
  private baseUrl: string;
  private clientToken: string;
  private accessToken: string;

  constructor(clientToken: string, accessToken: string, environment: "demo" | "production" = "demo") {
    this.baseUrl = environment === "demo"
      ? "https://api.mews-demo.com"
      : "https://api.mews.com";
    this.clientToken = clientToken;
    this.accessToken = accessToken;
  }

  private async makeRequest<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ClientToken: this.clientToken,
        AccessToken: this.accessToken,
        Client: "DreamBoks MEWS Adapter",
        ...body,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`MEWS API error ${response.status}: ${errorText}`);
    }

    return response.json();
  }

  async getActiveReservations(): Promise<MewsReservationsData> {
    const now = new Date();
    const startDate = new Date(now);
    startDate.setDate(startDate.getDate() - 1);
    const endDate = new Date(now);
    endDate.setDate(endDate.getDate() + 2);

    const response = await this.makeRequest<MewsReservationsResponse>(
      "/api/connector/v1/reservations/getAll",
      {
        TimeFilter: "Start",
        StartUtc: startDate.toISOString(),
        EndUtc: endDate.toISOString(),
        States: ["Confirmed", "Started"],
        Extent: {
          Reservations: true,
          ReservationGroups: true,
          ResourceCategories: true,
          Rates: true,
        },
      }
    );

    const reservations = response.Reservations || [];
    
    if (reservations.length === 0) {
      return {
        ...response,
        Customers: [],
        Resources: [],
        OrderItems: [],
      };
    }

    const customerIds = Array.from(new Set(reservations.map(r => r.CustomerId)));
    const customers = await this.getCustomers(customerIds);

    const resourceIds = Array.from(
      new Set(reservations.map(r => r.AssignedResourceId).filter(Boolean))
    ) as string[];
    const resources = resourceIds.length > 0 ? await this.getResources(resourceIds) : [];

    const reservationIds = reservations.map(r => r.Id);
    const orderItems = await this.getOrderItems(reservationIds);

    return {
      ...response,
      Customers: customers,
      Resources: resources,
      OrderItems: orderItems,
    };
  }

  private async getCustomers(customerIds: string[]): Promise<MewsCustomer[]> {
    if (customerIds.length === 0) return [];
    
    const response = await this.makeRequest<MewsCustomersResponse>(
      "/api/connector/v1/customers/getAll",
      {
        CustomerIds: customerIds,
        Extent: { Customers: true },
      }
    );
    return response.Customers;
  }

  private async getResources(resourceIds: string[]): Promise<MewsResource[]> {
    const response = await this.makeRequest<MewsResourcesResponse>(
      "/api/connector/v1/resources/getAll",
      {
        ResourceIds: resourceIds,
        Extent: { Resources: true },
      }
    );
    return response.Resources;
  }

  private async getOrderItems(reservationIds: string[]): Promise<MewsOrderItem[]> {
    if (reservationIds.length === 0) return [];
    
    const response = await this.makeRequest<MewsOrderItemsResponse>(
      "/api/connector/v1/orderItems/getAll",
      {
        ServiceOrderIds: reservationIds,
        Limitation: { Count: 100 },
      }
    );
    return response.OrderItems;
  }
}
