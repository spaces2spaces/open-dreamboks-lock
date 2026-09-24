/**
 * Mock MewsClient — recorder pattern.
 * Stores all addReservationNote calls and allows querying them.
 * Also supports getReservations + related methods for DriftReconciler tests
 * (real MewsAdapter calls these internally).
 */

interface NoteRecord {
  reservationId: string;
  note: string;
  timestamp: number;
}

interface CallRecord {
  method: string;
  args: any[];
  timestamp: number;
}

/** MEWS API-format reservation (subset of fields used by MewsAdapter) */
export interface MockMewsReservation {
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
}

export function createMockMewsClient() {
  const calls: CallRecord[] = [];
  const notes: NoteRecord[] = [];
  // MEWS-format reservations keyed by pmsId
  const mewsReservations = new Map<string, MockMewsReservation>();

  function record(method: string, args: any[]) {
    calls.push({ method, args, timestamp: Date.now() });
  }

  return {
    // ── MewsClient API methods used by PinLifecycleService ──

    async addReservationNote(
      reservationId: string,
      note: string
    ): Promise<{ Id: string }> {
      record("addReservationNote", [reservationId, note]);
      notes.push({ reservationId, note, timestamp: Date.now() });
      return { Id: `note-${Date.now()}` };
    },

    // ── MewsClient API methods used by MewsAdapter.fetchAndConvertSingleReservation ──

    async getReservations(ids: string[]): Promise<MockMewsReservation[]> {
      record("getReservations", [ids]);
      return ids
        .map((id) => mewsReservations.get(id))
        .filter((r): r is MockMewsReservation => !!r);
    },

    async getCustomers(customerIds: string[]): Promise<Array<{ Id: string; FirstName: string; LastName: string; Email: string; Phone: string | null }>> {
      record("getCustomers", [customerIds]);
      return customerIds.map((id) => ({
        Id: id,
        FirstName: "Test",
        LastName: "Guest",
        Email: "test@example.com",
        Phone: null,
      }));
    },

    async getOrderItems(_reservationIds: string[]): Promise<any[]> {
      record("getOrderItems", [_reservationIds]);
      return [];
    },

    async getBillBalancesForCustomers(_customerIds: string[]): Promise<Map<string, number>> {
      record("getBillBalancesForCustomers", [_customerIds]);
      return new Map();
    },

    async getResources(resourceIds: string[]): Promise<Array<{ Id: string; Name: string; State: string }>> {
      record("getResources", [resourceIds]);
      return resourceIds.map((id) => ({
        Id: id,
        Name: `Resource ${id}`,
        State: "Active",
      }));
    },

    // ── Test helpers ──

    reset() {
      calls.length = 0;
      notes.length = 0;
      mewsReservations.clear();
    },

    /**
     * Set a MEWS-format reservation in the mock.
     * DriftReconciler calls mewsClient.getReservations([pmsId]) to fetch this.
     */
    setMewsReservation(
      pmsId: string,
      data: {
        State: MockMewsReservation["State"];
        AssignedResourceId?: string;
        ScheduledStartUtc: string;
        ScheduledEndUtc: string;
      }
    ) {
      mewsReservations.set(pmsId, {
        Id: pmsId,
        State: data.State,
        StartUtc: data.ScheduledStartUtc,
        EndUtc: data.ScheduledEndUtc,
        ScheduledStartUtc: data.ScheduledStartUtc,
        ScheduledEndUtc: data.ScheduledEndUtc,
        CustomerId: `customer-${pmsId}`,
        AssignedResourceId: data.AssignedResourceId,
        AdultCount: 1,
        ChildCount: 0,
      });
    },

    getCallsFor(method: string): CallRecord[] {
      return calls.filter((c) => c.method === method);
    },

    getAllCalls(): CallRecord[] {
      return [...calls];
    },

    getNotesFor(reservationId: string): NoteRecord[] {
      return notes.filter((n) => n.reservationId === reservationId);
    },

    getAllNotes(): NoteRecord[] {
      return [...notes];
    },
  };
}

export type MockMewsClient = ReturnType<typeof createMockMewsClient>;
