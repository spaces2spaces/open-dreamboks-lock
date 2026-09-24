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
  CreatedUtc?: string;
  ChannelNumber?: string;
  ChannelManagerNumber?: string;
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
  /** Housekeeping state: "Dirty" | "Clean" | "Inspected" | "OutOfService" | "OutOfOrder" */
  State: string;
  /** Space payload — FloorNumber carries "Upper"/"Lower" for capsules. */
  Data?: {
    Discriminator?: string;
    Value?: { FloorNumber?: string | null; LocationNotes?: string | null } | null;
  } | null;
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
    NetValue: number;
    GrossValue: number;
  };
  UnitAmount: {
    Currency: string;
    NetValue: number;
    GrossValue: number;
  };
  UnitCount: number;
}

interface MewsReservationsResponse {
  Reservations: MewsReservation[];
  ReservationGroups?: MewsReservationGroup[];
  ResourceCategories?: MewsResourceCategory[];
  Rates?: MewsRate[];
}

interface MewsResourcesResponse {
  Resources: MewsResource[];
  Cursor?: string;
}

export interface MewsResourceBlock {
  Id: string;
  AssignedResourceId: string;
  /** "OutOfOrder" | "InternalUse" */
  Type: string;
  Name?: string;
  Notes?: string;
  StartUtc: string;
  EndUtc: string;
  IsDeleted?: boolean;
  DeletedUtc?: string | null;
}

interface MewsResourceBlocksResponse {
  ResourceBlocks?: MewsResourceBlock[];
  Cursor?: string;
}

interface MewsCustomersResponse {
  Customers: MewsCustomer[];
}

interface MewsOrderItemsResponse {
  OrderItems: MewsOrderItem[];
}

interface MewsServiceOrderNote {
  Id: string;
  OrderId: string;
  Text: string;
  Type: string;
  CreatedUtc: string;
  UpdatedUtc: string;
}

interface MewsServiceOrderNotesResponse {
  ServiceOrderNotes: MewsServiceOrderNote[];
}

interface MewsPayment {
  Id: string;
  AccountId: string;
  ReservationId?: string;
  Amount: {
    Currency: string;
    NetValue: number;
    GrossValue: number;
  };
  State: "Charged" | "Canceled" | "Pending" | "Failed" | "Verifying";
  Type: string;
  CreatedUtc: string;
  ChargedUtc?: string;
}

interface MewsPaymentsResponse {
  Payments: MewsPayment[];
  Cursor?: string;
}

interface MewsPaymentRequest {
  Id: string;
  AccountId: string;
  ReservationId?: string;
  State: "Pending" | "Completed" | "Canceled" | "Expired";
  Amount: {
    Currency: string;
    GrossValue: number;
  };
  ExpirationUtc?: string;
  Description?: string;
  CreatedUtc: string;
}

interface MewsPaymentRequestsResponse {
  PaymentRequests: MewsPaymentRequest[];
}

interface MewsAddPaymentRequestResponse {
  PaymentRequest: MewsPaymentRequest;
}

interface MewsIdentityDocument {
  Id: string;
  CustomerId: string;
  Type: string;
  Number: string;
  Expiration?: string;
  Issuance?: string;
  IssuingCountryCode?: string;
}

interface MewsIdentityDocumentsResponse {
  IdentityDocuments: MewsIdentityDocument[];
}

interface MewsBill {
  Id: string;
  AccountId?: string;
  AccountType?: string;
  State: "Open" | "Closed";
}

interface MewsBillAccountingItem {
  Id: string;
  BillId: string;
  Amount: {
    Currency: string;
    NetValue: number;
    GrossValue: number;
  };
}

interface MewsBillsResponse {
  Bills: MewsBill[];
  OrderItems?: MewsBillAccountingItem[];
  PaymentItems?: MewsBillAccountingItem[];
}

interface MewsAddress {
  Id: string;
  AccountId: string;
  Line1?: string;
  Line2?: string;
  City?: string;
  PostalCode?: string;
  CountryCode?: string;
  CountrySubdivisionCode?: string;
}

interface MewsAddressesResponse {
  Addresses: MewsAddress[];
}

export interface MewsGuestProfile {
  email?: string;
  nationality?: string;
  birthDate?: string;
  address?: {
    line1?: string;
    city?: string;
    postalCode?: string;
    countryCode?: string;
  };
  identityDocument?: {
    type: "Passport" | "IdentityCard" | "DriversLicense";
    number: string;
    expiration?: string;
    issuingCountryCode?: string;
  };
}

export class MewsClient {
  private baseUrl: string;
  private clientToken: string;
  private accessToken: string;
  private environment: "demo" | "production";

  constructor(clientToken: string, accessToken: string, environment: "demo" | "production" = "demo") {
    this.baseUrl = environment === "demo"
      ? "https://api.mews-demo.com"
      : "https://api.mews.com";
    this.clientToken = clientToken;
    this.accessToken = accessToken;
    this.environment = environment;
  }

  private async makeRequest<T>(endpoint: string, body: Record<string, any>): Promise<T> {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ClientToken: this.clientToken,
        AccessToken: this.accessToken,
        Client: "DreamBoks",
        ...body,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`MEWS API error: ${response.status} - ${error}`);
    }

    return response.json();
  }

  async getReservations(reservationIds: string[]): Promise<MewsReservation[]> {
    const response = await this.makeRequest<MewsReservationsResponse>(
      "/api/connector/v1/reservations/getAll",
      {
        ReservationIds: reservationIds,
        Extent: {
          Reservations: true,
        },
      }
    );
    return response.Reservations;
  }

  // MEWS' connector rejects a reservations/getAll TimeFilter window whose interval
  // exceeds 100 hours ("The interval must not exceed 100:00:00"). Our sync windows
  // (full sync + in-house horizon ≈ 30 days) blow past that, which silently broke
  // ALL reservation syncing — new bookings, cancellations AND room reassignments
  // stopped propagating. We split any window into ≤96h slices and merge the
  // per-slice responses, deduped by Id, so callers see one combined result.
  private static readonly MAX_TIMEFILTER_MS = 96 * 60 * 60 * 1000; // 96h, safely under MEWS' 100h cap

  private async fetchReservationsChunked(
    timeFilter: "Start" | "End" | "Updated",
    startUtc: Date,
    endUtc: Date,
    states: string[],
  ): Promise<MewsReservationsResponse> {
    const extent = { Reservations: true, ReservationGroups: true, ResourceCategories: true };
    const startMs = startUtc.getTime();
    const endMs = endUtc.getTime();

    // Cover [startUtc, endUtc) in ≤MAX_TIMEFILTER_MS slices. A degenerate/empty
    // window still issues one request so behaviour matches the old single call.
    const slices: Array<{ start: string; end: string }> = [];
    for (let s = startMs; s < endMs; s += MewsClient.MAX_TIMEFILTER_MS) {
      const e = Math.min(s + MewsClient.MAX_TIMEFILTER_MS, endMs);
      slices.push({ start: new Date(s).toISOString(), end: new Date(e).toISOString() });
    }
    if (slices.length === 0) {
      slices.push({ start: startUtc.toISOString(), end: endUtc.toISOString() });
    }

    const merged: Required<MewsReservationsResponse> = {
      Reservations: [], ReservationGroups: [], ResourceCategories: [], Rates: [],
    };
    const seenRes = new Set<string>(), seenGrp = new Set<string>(),
          seenCat = new Set<string>(), seenRate = new Set<string>();

    for (const slice of slices) {
      const resp = await this.makeRequest<MewsReservationsResponse>(
        "/api/connector/v1/reservations/getAll",
        { TimeFilter: timeFilter, StartUtc: slice.start, EndUtc: slice.end, States: states, Extent: extent },
      );
      for (const r of resp.Reservations || []) if (!seenRes.has(r.Id)) { seenRes.add(r.Id); merged.Reservations.push(r); }
      for (const g of resp.ReservationGroups || []) if (!seenGrp.has(g.Id)) { seenGrp.add(g.Id); merged.ReservationGroups.push(g); }
      for (const c of resp.ResourceCategories || []) if (!seenCat.has(c.Id)) { seenCat.add(c.Id); merged.ResourceCategories.push(c); }
      for (const rt of resp.Rates || []) if (!seenRate.has(rt.Id)) { seenRate.add(rt.Id); merged.Rates.push(rt); }
    }
    return merged;
  }

  async getReservationsByTimeFilter(startUtc: string, endUtc: string): Promise<MewsReservationsResponse> {
    return this.fetchReservationsChunked(
      "Start", new Date(startUtc), new Date(endUtc),
      ["Confirmed", "Started", "Processed", "Canceled"],
    );
  }

  async getActiveReservations(daysAhead: number = 1, daysBack: number = 0): Promise<MewsReservationsResponse> {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const startDate = new Date(startOfToday);
    startDate.setDate(startOfToday.getDate() - daysBack);

    const endDate = new Date(startOfToday);
    endDate.setDate(startOfToday.getDate() + daysAhead + 1);

    return this.fetchReservationsChunked(
      "Start", startDate, endDate,
      ["Confirmed", "Started", "Processed", "Canceled"],
    );
  }

  async getInHouseReservations(daysAhead: number = 7): Promise<MewsReservationsResponse> {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const endDate = new Date(startOfToday);
    endDate.setDate(startOfToday.getDate() + daysAhead + 1);

    return this.fetchReservationsChunked(
      "End", startOfToday, endDate,
      ["Started", "Processed"],
    );
  }

  async getUpdatedReservations(sinceUtc: Date): Promise<MewsReservationsResponse> {
    const endUtc = new Date(Date.now() + 60_000); // 1 min buffer
    return this.fetchReservationsChunked(
      "Updated", sinceUtc, endUtc,
      ["Confirmed", "Started", "Processed", "Canceled"],
    );
  }

  async getOrderItems(reservationIds: string[]): Promise<MewsOrderItem[]> {
    if (reservationIds.length === 0) return [];
    const response = await this.makeRequest<MewsOrderItemsResponse>(
      "/api/connector/v1/orderItems/getAll",
      {
        ServiceOrderIds: reservationIds,
        Limitation: {
          Count: 100,
        },
      }
    );
    return response.OrderItems;
  }

  async getResources(resourceIds?: string[]): Promise<MewsResource[]> {
    const allResources: MewsResource[] = [];
    let cursor: string | undefined = undefined;

    do {
      const requestBody: Record<string, any> = {
        Extent: { Resources: true },
        Limitation: { Count: 1000, Cursor: cursor },
      };

      if (resourceIds && resourceIds.length > 0) {
        requestBody.ResourceIds = resourceIds;
      }

      const response = await this.makeRequest<MewsResourcesResponse>(
        "/api/connector/v1/resources/getAll",
        requestBody
      );

      allResources.push(...response.Resources);
      cursor = response.Cursor;
    } while (cursor);

    return allResources;
  }

  /**
   * Post a product order line onto a reservation (e.g. the "Early check-in"
   * product) so a kiosk payment settles against a real product instead of
   * sitting as unallocated credit. UnitAmount overrides the product's
   * configured price so the charge always matches what was actually paid.
   * TaxCodes is mandatory alongside GrossValue: an Amount override without it
   * makes Mews treat the whole line as tax-exempt (TaxCodes:null), overriding
   * the VAT configured on the product itself.
   * NOTE: requires reservations/addProduct in the Mews API scope.
   */
  async addReservationProduct(
    reservationId: string,
    productId: string,
    count: number,
    unitAmount?: { currency: string; grossValue: number; taxCode: string }
  ): Promise<void> {
    await this.makeRequest<object>("/api/connector/v1/reservations/addProduct", {
      ReservationId: reservationId,
      ProductId: productId,
      Count: count,
      ...(unitAmount
        ? {
            UnitAmount: {
              Currency: unitAmount.currency,
              GrossValue: unitAmount.grossValue,
              TaxCodes: [unitAmount.taxCode],
            },
          }
        : {}),
    });
  }

  /**
   * Resource blocks (out-of-order / internal-use) colliding with a time window.
   * Endpoint enabled for DreamBoks by Mews Partner Success 2026-07-17
   * (case 00687991) — was previously outside our permission scope.
   */
  async getResourceBlocks(collidingStartUtc: string, collidingEndUtc: string): Promise<MewsResourceBlock[]> {
    const allBlocks: MewsResourceBlock[] = [];
    let cursor: string | undefined = undefined;

    do {
      const response: MewsResourceBlocksResponse = await this.makeRequest<MewsResourceBlocksResponse>(
        "/api/connector/v1/resourceBlocks/getAll",
        {
          CollidingUtc: { StartUtc: collidingStartUtc, EndUtc: collidingEndUtc },
          Limitation: { Count: 1000, Cursor: cursor },
        }
      );
      allBlocks.push(...(response.ResourceBlocks ?? []));
      cursor = response.Cursor;
    } while (cursor);

    // Deleted blocks are returned with IsDeleted/DeletedUtc — filter them out.
    return allBlocks.filter(b => !b.IsDeleted && !b.DeletedUtc);
  }

  async getCustomers(customerIds: string[]): Promise<MewsCustomer[]> {
    const response = await this.makeRequest<MewsCustomersResponse>(
      "/api/connector/v1/customers/getAll",
      {
        CustomerIds: customerIds,
        Extent: {
          Customers: true,
        },
      }
    );
    return response.Customers;
  }

  async addReservationNote(reservationId: string, noteText: string): Promise<MewsServiceOrderNote> {
    const response = await this.makeRequest<MewsServiceOrderNotesResponse>(
      "/api/connector/v1/serviceOrderNotes/add",
      {
        ServiceOrderNotes: [
          {
            ServiceOrderId: reservationId,
            Text: noteText,
          },
        ],
      }
    );
    const note = response.ServiceOrderNotes?.[0];
    if (!note) {
      throw new Error(`MEWS did not confirm note creation for reservation ${reservationId}`);
    }
    return note;
  }

  async getReservationNotes(reservationId: string): Promise<MewsServiceOrderNote[]> {
    const response = await this.makeRequest<MewsServiceOrderNotesResponse>(
      "/api/connector/v1/serviceOrderNotes/getAll",
      {
        ServiceOrderIds: [reservationId],
        Limitation: { Count: 100 },
      }
    );
    return response.ServiceOrderNotes || [];
  }

  async deleteReservationNotes(noteIds: string[]): Promise<void> {
    if (noteIds.length === 0) return;
    await this.makeRequest<object>(
      "/api/connector/v1/serviceOrderNotes/delete",
      { ServiceOrderNoteIds: noteIds }
    );
  }

  async getPayments(reservationIds: string[]): Promise<MewsPayment[]> {
    if (reservationIds.length === 0) return [];
    const response = await this.makeRequest<MewsPaymentsResponse>(
      "/api/connector/v1/payments/getAll",
      {
        ReservationIds: reservationIds,
        States: ["Charged", "Pending", "Verifying"],
        Limitation: {
          Count: 100,
        },
      }
    );
    return response.Payments || [];
  }

  /**
   * Create a minimal MEWS customer profile (hourly-rental guests don't exist
   * in MEWS — a customer account is required to issue a payment request).
   * customers/add returns the customer object directly (not wrapped).
   */
  async addCustomer(input: { firstName?: string; lastName: string; email?: string; phone?: string }): Promise<MewsCustomer> {
    const body: Record<string, any> = {
      LastName: input.lastName,
      OverwriteExisting: false,
    };
    if (input.firstName) body.FirstName = input.firstName;
    if (input.email) body.Email = input.email;
    if (input.phone) body.Phone = input.phone;
    try {
      return await this.makeRequest<MewsCustomer>("/api/connector/v1/customers/add", body);
    } catch (error) {
      // "A customer with the specified email already exists." — reuse the
      // existing profile instead of failing (repeat guests, or staff testing
      // with their own email). Deliberately NOT OverwriteExisting: true — that
      // would rename a real guest's MEWS profile to whatever this booking says.
      const msg = error instanceof Error ? error.message : String(error);
      if (input.email && /already exists/i.test(msg)) {
        const existing = await this.getCustomersByEmail(input.email);
        if (existing.length > 0) return existing[0];
      }
      throw error;
    }
  }

  /** Look up customers by exact email (used to resolve "already exists" on add). */
  async getCustomersByEmail(email: string): Promise<MewsCustomer[]> {
    const response = await this.makeRequest<{ Customers: MewsCustomer[] }>(
      "/api/connector/v1/customers/getAll",
      { Emails: [email], Limitation: { Count: 10 } },
    );
    return response.Customers ?? [];
  }

  /**
   * Set/replace a customer's email. customers/update takes PLAIN string
   * fields — a {Value} wrapper is rejected as "Invalid JSON." (verified
   * empirically 25/7 against a throwaway customer). Used when
   * paymentRequests/add is refused with 403 "Please enter a valid email
   * address for customer." — OTA-imported customers often have none.
   */
  async updateCustomerEmail(customerId: string, email: string): Promise<void> {
    await this.makeRequest("/api/connector/v1/customers/update", {
      CustomerId: customerId,
      Email: email,
    });
  }

  /** Look up payment requests by their own ids (hourly rentals have no reservation). */
  async getPaymentRequestsByIds(paymentRequestIds: string[]): Promise<MewsPaymentRequest[]> {
    if (paymentRequestIds.length === 0) return [];
    const response = await this.makeRequest<MewsPaymentRequestsResponse>(
      "/api/connector/v1/paymentRequests/getAll",
      {
        PaymentRequestIds: paymentRequestIds,
        States: ["Pending", "Completed", "Canceled", "Expired"],
        Limitation: { Count: 100 },
      }
    );
    return response.PaymentRequests || [];
  }

  async getPaymentRequests(reservationIds: string[]): Promise<MewsPaymentRequest[]> {
    if (reservationIds.length === 0) return [];
    const response = await this.makeRequest<MewsPaymentRequestsResponse>(
      "/api/connector/v1/paymentRequests/getAll",
      {
        ReservationIds: reservationIds,
        States: ["Pending", "Completed"],
        Limitation: {
          Count: 100,
        },
      }
    );
    return response.PaymentRequests || [];
  }

  async createPaymentRequest(
    customerId: string,
    amount: number,
    currency: string,
    reservationId?: string,
    description?: string,
    expirationUtc?: string,
    sendEmail: boolean = true
  ): Promise<MewsPaymentRequest> {
    const paymentRequest: Record<string, any> = {
      AccountId: customerId,
      Amount: {
        Currency: currency,
        Value: amount,
      },
      Type: "Payment",
      Reason: "Prepayment",
      Description: description || "Payment required for reservation",
      ExpirationUtc: expirationUtc || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      SendPaymentRequestEmails: sendEmail,
    };

    if (reservationId) {
      paymentRequest.ReservationId = reservationId;
    }

    const response = await this.makeRequest<{ PaymentRequests: MewsPaymentRequest[] }>(
      "/api/connector/v1/paymentRequests/add",
      {
        PaymentRequests: [paymentRequest],
      }
    );
    return response.PaymentRequests[0];
  }

  getPaymentRequestUrl(paymentRequestId: string): string {
    const navigatorBase = this.environment === "production"
      ? "https://app.mews.com"
      : "https://app.mews-demo.com";
    return `${navigatorBase}/navigator/payment-requests/detail/${paymentRequestId}`;
  }

  isPaymentComplete(payments: MewsPayment[]): boolean {
    return payments.some(payment => payment.State === "Charged");
  }

  async startReservation(reservationId: string): Promise<{ success: boolean; error?: string }> {
    try {
      await this.makeRequest<any>(
        "/api/connector/v1/reservations/start",
        {
          ReservationId: reservationId,
        }
      );
      console.log(`MEWS check-in: Reservation ${reservationId} started successfully`);
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`MEWS check-in failed for ${reservationId}: ${errorMessage}`);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Create a reservation (scope-verified OPEN 2026-07-21, see
   * scripts/mews-scope-probe.ts). Used by the hourly-booking flow to occupy a
   * capsule in MEWS. `identifier` (our hourly_bookings.id) lets MEWS dedupe
   * retries of the same logical reservation.
   * NOTE: rates/getAll is scope-CLOSED — RateId comes from settings (mined
   * from live reservations), never from a rates lookup.
   *
   * 28/7 (probe: scripts/probe-mews-add-assigned-resource.mts, incident
   * aaad641b): `assignedResourceId` + `assignedResourceLocked` ARE honored at
   * creation — the space is correct and locked from the first second, so
   * MEWS' online check-in can never freeze a wrong auto-assignment.
   * REQUIREMENT: `requestedCategoryId` must then be the resource's OWN
   * category (it cannot be omitted), otherwise 400 "Invalid
   * AssignedResourceId: resource does not belong to the requested category."
   * — deterministic and creates NOTHING. Membership is not readable
   * (resourceCategoryAssignments/getAll is scope-CLOSED), so callers ladder
   * over the service's categories and cache the hit. The rate and
   * TimeUnitPrices work across categories (probe-verified).
   */
  async createReservation(input: {
    serviceId: string;
    rateId: string;
    requestedCategoryId: string;
    customerId: string;
    startUtc: Date;
    endUtc: Date;
    identifier?: string;
    notes?: string;
    adultCount?: number;
    /** Pin the exact space at creation — requires requestedCategoryId to be the space's own category. */
    assignedResourceId?: string;
    /** Lock the assignment at creation so auto-assignment can never move it (default true when assignedResourceId is set). */
    assignedResourceLocked?: boolean;
    /**
     * Override the rate's price with what the guest ACTUALLY paid (e.g. the
     * 399-package on an hourly booking). Requires a tax code on the amount —
     * "DK-S" (Danish standard VAT) verified accepted 24/7.
     */
    priceOverride?: { grossValue: number; currency: string; taxCode: string };
  }): Promise<{ reservationId: string }> {
    const response = await this.makeRequest<{
      Reservations?: Array<{ Identifier?: string | null; Reservation?: { Id: string } } | { Id: string }>;
    }>("/api/connector/v1/reservations/add", {
      ServiceId: input.serviceId,
      Reservations: [
        {
          Identifier: input.identifier,
          StartUtc: input.startUtc.toISOString(),
          EndUtc: input.endUtc.toISOString(),
          RateId: input.rateId,
          RequestedCategoryId: input.requestedCategoryId,
          CustomerId: input.customerId,
          AdultCount: input.adultCount ?? 1,
          ChildCount: 0,
          Notes: input.notes,
          ...(input.assignedResourceId
            ? {
                AssignedResourceId: input.assignedResourceId,
                AssignedResourceLocked: input.assignedResourceLocked ?? true,
              }
            : {}),
          ...(input.priceOverride
            ? {
                TimeUnitPrices: [
                  {
                    Index: 0,
                    Amount: {
                      Currency: input.priceOverride.currency,
                      GrossValue: input.priceOverride.grossValue,
                      TaxCodes: [input.priceOverride.taxCode],
                    },
                  },
                ],
              }
            : {}),
        },
      ],
    });
    // Response items are either { Identifier, Reservation: {...} } (grouped) or
    // the reservation object directly, depending on API version — handle both.
    const first: any = response.Reservations?.[0];
    const id: string | undefined = first?.Reservation?.Id ?? first?.Id;
    if (!id) throw new Error(`reservations/add returned no reservation id: ${JSON.stringify(response).slice(0, 300)}`);
    return { reservationId: id };
  }

  /**
   * Categories of a service (resourceCategories/getAll with ServiceIds —
   * scope-verified OPEN 2026-07-21/28). Used to resolve a capsule's OWN
   * category for assignment-at-creation, since
   * resourceCategoryAssignments/getAll is scope-CLOSED (401, probed 28/7).
   */
  async getServiceResourceCategories(serviceId: string): Promise<Array<{ Id: string; Names?: Record<string, string> }>> {
    const response = await this.makeRequest<{
      ResourceCategories?: Array<{ Id: string; Names?: Record<string, string> }>;
    }>("/api/connector/v1/resourceCategories/getAll", {
      ServiceIds: [serviceId],
      Limitation: { Count: 100 },
    });
    return response.ResourceCategories ?? [];
  }

  /**
   * Pin a reservation to an exact space and lock the assignment so MEWS
   * auto-assignment can't move it (scope-verified OPEN 2026-07-21).
   * Body shape verified empirically 21/7: the field is `ReservationUpdates`
   * (NOT `Reservations` — that answers 400 "Invalid ReservationId" even for
   * valid ids). A locked assignment answers 403 "Cannot move reservation.
   * Please unlock and try again" — retried as unlock → move+lock.
   * 28/7 (incident aaad641b): a guest who completes MEWS ONLINE CHECK-IN
   * hard-locks the assignment — the unlock retry does NOT help then. Primary
   * defense is assigning the space at creation (createReservation
   * assignedResourceId); this update is the fallback path only.
   */
  async updateReservationAssignedResource(
    reservationId: string,
    resourceId: string
  ): Promise<{ success: boolean; error?: string }> {
    const move = () =>
      this.makeRequest<any>("/api/connector/v1/reservations/update", {
        ReservationUpdates: [
          {
            ReservationId: reservationId,
            AssignedResourceId: { Value: resourceId },
            AssignedResourceLocked: { Value: true },
          },
        ],
      });
    try {
      await move();
      return { success: true };
    } catch (error) {
      const firstError = error instanceof Error ? error.message : String(error);
      if (/unlock/i.test(firstError)) {
        try {
          await this.makeRequest<any>("/api/connector/v1/reservations/update", {
            ReservationUpdates: [
              { ReservationId: reservationId, AssignedResourceLocked: { Value: false } },
            ],
          });
          await move();
          return { success: true };
        } catch (retryError) {
          const msg = retryError instanceof Error ? retryError.message : String(retryError);
          console.error(`MEWS assign-resource (unlock retry) failed for ${reservationId}: ${msg}`);
          return { success: false, error: msg };
        }
      }
      console.error(`MEWS assign-resource failed for ${reservationId}: ${firstError}`);
      return { success: false, error: firstError };
    }
  }

  /**
   * Mark a reservation checked out (Processed) — the hourly-booking checkout
   * signal (scope-verified OPEN 2026-07-21). Idempotent: "already processed" /
   * invalid-state answers count as success so the sweep can safely retry.
   */
  async processReservation(reservationId: string): Promise<{ success: boolean; error?: string }> {
    try {
      await this.makeRequest<any>("/api/connector/v1/reservations/process", {
        ReservationId: reservationId,
      });
      console.log(`MEWS checkout: Reservation ${reservationId} processed successfully`);
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (/already|processed|state/i.test(errorMessage)) {
        return { success: true };
      }
      console.error(`MEWS checkout failed for ${reservationId}: ${errorMessage}`);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Move a reservation's departure (EndUtc). Same `ReservationUpdates` body
   * shape as the space update. Verified 24/7 against production: a same-day
   * extension (10:00 → 13:00) is accepted with State unchanged and adds no
   * extra night/charge — this is what keeps MEWS' own auto-checkout from
   * firing at the standard time when a guest has paid for late check-out.
   */
  async updateReservationEndUtc(reservationId: string, endUtc: Date): Promise<void> {
    await this.makeRequest("/api/connector/v1/reservations/update", {
      ReservationUpdates: [
        { ReservationId: reservationId, EndUtc: { Value: endUtc.toISOString() } },
      ],
    });
  }

  async cancelReservation(reservationId: string, reason?: string): Promise<{ success: boolean; error?: string }> {
    try {
      await this.makeRequest<any>(
        "/api/connector/v1/reservations/cancel",
        {
          ReservationIds: [reservationId],
          ChargeCancellationFee: false,
          Notes: reason || "No-show: Guest did not arrive",
        }
      );
      console.log(`MEWS cancel: Reservation ${reservationId} cancelled as no-show`);
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`MEWS cancel failed for ${reservationId}: ${errorMessage}`);
      return { success: false, error: errorMessage };
    }
  }

  async updateCustomer(customerId: string, updates: {
    NationalityCode?: string;
    BirthDate?: string;
    Email?: string;
    Phone?: string;
  }): Promise<{ success: boolean; error?: string }> {
    try {
      await this.makeRequest<any>(
        "/api/connector/v1/customers/update",
        {
          CustomerId: customerId,
          ...updates,
        }
      );
      console.log(`[MEWS] Customer ${customerId} updated: ${Object.keys(updates).join(", ")}`);
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[MEWS] Customer update failed for ${customerId}: ${errorMessage}`);
      return { success: false, error: errorMessage };
    }
  }

  async addAddress(customerId: string, address: {
    line1: string;
    city?: string;
    postalCode?: string;
    countryCode?: string;
  }): Promise<{ success: boolean; error?: string }> {
    try {
      await this.makeRequest<MewsAddressesResponse>(
        "/api/connector/v1/addresses/add",
        {
          Addresses: [{
            AccountId: customerId,
            AccountType: "Customer",
            Line1: address.line1,
            City: address.city,
            PostalCode: address.postalCode,
            CountryCode: address.countryCode,
          }],
        }
      );
      console.log(`[MEWS] Address added for customer ${customerId}`);
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[MEWS] Address add failed for ${customerId}: ${errorMessage}`);
      return { success: false, error: errorMessage };
    }
  }

  async addIdentityDocument(customerId: string, doc: {
    type: "Passport" | "IdentityCard" | "DriversLicense";
    number: string;
    expiration?: string;
    issuingCountryCode?: string;
  }): Promise<{ success: boolean; error?: string }> {
    try {
      await this.makeRequest<MewsIdentityDocumentsResponse>(
        "/api/connector/v1/identityDocuments/add",
        {
          IdentityDocuments: [{
            CustomerId: customerId,
            Type: doc.type,
            Number: doc.number,
            Expiration: doc.expiration,
            IssuingCountryCode: doc.issuingCountryCode,
          }],
        }
      );
      console.log(`[MEWS] Identity document (${doc.type}) added for customer ${customerId}`);
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[MEWS] Identity document add failed for ${customerId}: ${errorMessage}`);
      return { success: false, error: errorMessage };
    }
  }

  async getIdentityDocuments(customerIds: string[]): Promise<MewsIdentityDocument[]> {
    if (customerIds.length === 0) return [];
    const response = await this.makeRequest<MewsIdentityDocumentsResponse>(
      "/api/connector/v1/identityDocuments/getAll",
      {
        CustomerIds: customerIds,
        Limitation: {
          Count: 100,
        },
      }
    );
    return response.IdentityDocuments || [];
  }

  async syncGuestProfile(customerId: string, profile: MewsGuestProfile): Promise<{ success: boolean; errors: string[] }> {
    const errors: string[] = [];

    if (profile.email || profile.nationality || profile.birthDate) {
      const customerUpdates: Record<string, string> = {};
      if (profile.email) customerUpdates.Email = profile.email;
      if (profile.nationality) customerUpdates.NationalityCode = profile.nationality;
      if (profile.birthDate) customerUpdates.BirthDate = profile.birthDate;
      const result = await this.updateCustomer(customerId, customerUpdates);
      if (!result.success) errors.push(`Customer update: ${result.error}`);
    }

    if (profile.address?.line1) {
      const result = await this.addAddress(customerId, { ...profile.address, line1: profile.address.line1 });
      if (!result.success) errors.push(`Address: ${result.error}`);
    }

    if (profile.identityDocument?.number) {
      const result = await this.addIdentityDocument(customerId, profile.identityDocument);
      if (!result.success) errors.push(`ID document: ${result.error}`);
    }

    return { success: errors.length === 0, errors };
  }

  /**
   * Returns the total open bill balance for a customer account.
   * This reflects what MEWS shows as "Customer Balance" — correctly handles
   * billing automation (e.g. OTA bookings where charges move to company bill).
   */
  /**
   * Fetches open bill balances for multiple customers in a single API call.
   * Returns a map of customerId → balance (0 if no open bills).
   * Returns empty map on API error (caller should fall back to order items calculation).
   */
  async getBillBalancesForCustomers(customerIds: string[]): Promise<Map<string, number>> {
    if (customerIds.length === 0) return new Map();
    // Use orderItems/getAll + payments/getAll with AccountIds.
    // bills/getAll Extent.OrderItems/PaymentItems is deprecated and returns empty arrays.
    // Payments in MEWS are stored as negative GrossValues, so simply summing both gives net balance.
    // Batch in groups of 500 to stay within MEWS API array limits.
    type AccountItem = { AccountId?: string; Amount?: { GrossValue: number } };
    const BATCH = 100; // MEWS limits AccountIds to max 100 per call
    const result = new Map<string, number>();
    for (const id of customerIds) result.set(id, 0);

    for (let i = 0; i < customerIds.length; i += BATCH) {
      const batch = customerIds.slice(i, i + BATCH);
      try {
        const [orderItemsResp, paymentsResp] = await Promise.all([
          this.makeRequest<{ OrderItems: AccountItem[] }>(
            "/api/connector/v1/orderItems/getAll",
            {
              AccountIds: batch,
              AccountingStates: ["Open"],
              Limitation: { Count: 1000 },
            }
          ),
          this.makeRequest<{ Payments: AccountItem[] }>(
            "/api/connector/v1/payments/getAll",
            {
              AccountIds: batch,
              AccountingStates: ["Open"],
              Limitation: { Count: 1000 },
            }
          ),
        ]);

        for (const item of orderItemsResp.OrderItems || []) {
          if (item.AccountId && result.has(item.AccountId)) {
            result.set(item.AccountId, result.get(item.AccountId)! + (item.Amount?.GrossValue || 0));
          }
        }
        for (const payment of paymentsResp.Payments || []) {
          if (payment.AccountId && result.has(payment.AccountId)) {
            result.set(payment.AccountId, result.get(payment.AccountId)! + (payment.Amount?.GrossValue || 0));
          }
        }
      } catch {
        // On batch error: leave this batch's customers at 0 (initialised above)
        // The adapter treats map.size>0 as a successful call, so balances default to 0
        // which is safer than returning an empty map and losing all updates.
      }
    }

    for (const k of Array.from(result.keys())) result.set(k, Math.max(0, result.get(k)!));
    return result;
  }

  async getCustomerBillBalance(customerId: string): Promise<{ value: number; currency: string } | null> {
    const map = await this.getBillBalancesForCustomers([customerId]);
    if (map.size === 0) return null;
    return { value: map.get(customerId) ?? 0, currency: "DKK" };
  }
}
