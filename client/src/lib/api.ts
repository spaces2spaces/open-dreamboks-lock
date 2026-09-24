import type { Room as DBRoom, CommonArea as DBCommonArea, Reservation as DBReservation, Pin as DBPin, Setting, Log, ReservationLog, QrCode, LockDevice, RoomLockAssignment } from "@shared/schema";
import type { Room, CommonArea, Reservation, Pin } from "./mockData";
import { getHotelInfo, getAuthToken } from "./auth";

const API_BASE = "/api";

export async function fetchAPI<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const hotelInfo = getHotelInfo();
  const authToken = getAuthToken();
  const existingHeaders = options?.headers as Record<string, string> | undefined;
  
  const headers: HeadersInit = {
    "Content-Type": "application/json",
    ...options?.headers,
  };
  
  if (hotelInfo?.id && !existingHeaders?.["x-tenant-id"]) {
    (headers as Record<string, string>)["x-tenant-id"] = hotelInfo.id;
  }
  
  if (authToken && !existingHeaders?.["Authorization"]) {
    (headers as Record<string, string>)["Authorization"] = `Bearer ${authToken}`;
  }
  
  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Request failed" }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  if (response.status === 204) {
    return null as T;
  }

  return response.json();
}

// Fetch API with explicit tenant ID (for onboarding when not logged in).
// The invitation token is sent as x-setup-token so the backend can authorize
// onboarding calls before a hotel_user session exists.
async function fetchAPIWithTenant<T>(endpoint: string, tenantId: string, setupToken?: string, options?: RequestInit): Promise<T> {
  const headers: HeadersInit = {
    "Content-Type": "application/json",
    "x-tenant-id": tenantId,
    ...(setupToken ? { "x-setup-token": setupToken } : {}),
    ...options?.headers,
  };

  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Request failed" }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  if (response.status === 204) {
    return null as T;
  }

  return response.json();
}

// Create tenant-scoped API functions for onboarding.
// setupToken is the invitation token; it authorizes these calls before login.
export function createTenantScopedAPI(tenantId: string, setupToken?: string) {
  return {
    settings: {
      getAll: () => fetchAPIWithTenant<Setting[]>("/settings", tenantId, setupToken),
      update: (key: string, value: string) => fetchAPIWithTenant<Setting>(`/settings/${key}`, tenantId, setupToken, {
        method: "PUT",
        body: JSON.stringify({ value }),
      }),
    },
    rooms: {
      getAll: async () => {
        const dbRooms = await fetchAPIWithTenant<DBRoom[]>("/rooms", tenantId, setupToken);
        return dbRooms.map(convertDBRoomToRoom);
      },
      sync: () => fetchAPIWithTenant<{ success: boolean; imported: number; updated: number; total: number }>("/sync-spaces", tenantId, setupToken, { method: "POST" }),
    },
    lockDevices: {
      getAll: () => fetchAPIWithTenant<LockDevice[]>("/lock-devices", tenantId, setupToken),
      sync: () => fetchAPIWithTenant<{ success: boolean; imported: number; updated: number; removed: number; totalLocks: number; locks: string[] }>("/sync-ttlocks", tenantId, setupToken, { method: "POST" }),
    },
    ttlock: {
      refreshToken: () => fetchAPIWithTenant<{ success: boolean }>("/ttlock/refresh-token", tenantId, setupToken, { method: "POST" }),
    },
  };
}

function convertDBRoomToRoom(dbRoom: DBRoom): Room {
  return {
    id: dbRoom.id,
    name: dbRoom.name,
    type: dbRoom.type as "room" | "dorm",
    beds: dbRoom.beds,
    pmsStatus: dbRoom.pmsStatus as "mapped" | "unmapped",
    pmsId: dbRoom.pmsId || null,
    ttlockId: dbRoom.ttlockId || null,
    battery: dbRoom.battery,
    floor: dbRoom.floor || undefined,
    ordering: dbRoom.ordering || undefined,
    commonAreas: (dbRoom.commonAreas as string[]) || [],
    isDreamBoks: dbRoom.isDreamBoks,
    spaceCategory: dbRoom.spaceCategory || null,
    label: dbRoom.label || null,
  };
}

function convertDBCommonAreaToCommonArea(dbArea: DBCommonArea): CommonArea {
  return {
    id: dbArea.id,
    name: dbArea.name,
    battery: dbArea.battery,
    floor: dbArea.floor || undefined,
    building: dbArea.building || undefined,
    accessScope: dbArea.accessScope as CommonArea["accessScope"],
    ttlockId: dbArea.ttlockId || null,
  };
}

// Rooms API
export const roomsAPI = {
  getAll: async () => {
    const dbRooms = await fetchAPI<DBRoom[]>("/rooms");
    return dbRooms.map(convertDBRoomToRoom);
  },
  getOne: async (id: string) => {
    const dbRoom = await fetchAPI<DBRoom>(`/rooms/${id}`);
    return convertDBRoomToRoom(dbRoom);
  },
  create: async (room: Partial<Room>) => {
    const dbRoom = await fetchAPI<DBRoom>("/rooms", {
      method: "POST",
      body: JSON.stringify(room),
    });
    return convertDBRoomToRoom(dbRoom);
  },
  update: async (id: string, room: Partial<Room>) => {
    const dbRoom = await fetchAPI<DBRoom>(`/rooms/${id}`, {
      method: "PUT",
      body: JSON.stringify(room),
    });
    return convertDBRoomToRoom(dbRoom);
  },
  delete: (id: string) => fetchAPI<void>(`/rooms/${id}`, { method: "DELETE" }),
  sync: () => fetchAPI<{ success: boolean; imported: number; updated: number; total: number }>("/sync-spaces", {
    method: "POST",
  }),
};

// Common Areas API
export const commonAreasAPI = {
  getAll: async () => {
    const dbAreas = await fetchAPI<DBCommonArea[]>("/common-areas");
    return dbAreas.map(convertDBCommonAreaToCommonArea);
  },
  getOne: async (id: string) => {
    const dbArea = await fetchAPI<DBCommonArea>(`/common-areas/${id}`);
    return convertDBCommonAreaToCommonArea(dbArea);
  },
  create: async (area: Partial<CommonArea>) => {
    const dbArea = await fetchAPI<DBCommonArea>("/common-areas", {
      method: "POST",
      body: JSON.stringify(area),
    });
    return convertDBCommonAreaToCommonArea(dbArea);
  },
  update: async (id: string, area: Partial<CommonArea>) => {
    const dbArea = await fetchAPI<DBCommonArea>(`/common-areas/${id}`, {
      method: "PUT",
      body: JSON.stringify(area),
    });
    return convertDBCommonAreaToCommonArea(dbArea);
  },
};

function convertDBReservationToReservation(dbRes: DBReservation): Reservation {
  return {
    id: dbRes.id,
    email: dbRes.email || "",
    firstName: dbRes.firstName,
    lastName: dbRes.lastName,
    arrival: typeof dbRes.arrival === 'string' ? dbRes.arrival : dbRes.arrival.toISOString(),
    departure: typeof dbRes.departure === 'string' ? dbRes.departure : dbRes.departure.toISOString(),
    pmsId: dbRes.pmsId,
    extId: dbRes.extId || "",
    adults: dbRes.adults,
    children: dbRes.children,
    status: dbRes.status as "Confirmed" | "Canceled" | "Checked-in",
    room: dbRes.room || undefined,
    bed: dbRes.bed || undefined,
    price: dbRes.price || undefined,
    currency: dbRes.currency || undefined,
    owing: dbRes.owing || undefined,
    mobile: dbRes.mobile || undefined,
    confirmationCode: dbRes.confirmationCode || undefined,
    preCheckinStatus: dbRes.preCheckinStatus || null,
  };
}

// Reservations API
export const reservationsAPI = {
  getAll: async () => {
    const dbReservations = await fetchAPI<DBReservation[]>("/reservations");
    return dbReservations.map(convertDBReservationToReservation);
  },
  getOne: async (id: string) => {
    const dbReservation = await fetchAPI<DBReservation>(`/reservations/${id}`);
    return convertDBReservationToReservation(dbReservation);
  },
  create: async (reservation: Partial<Reservation>) => {
    const dbReservation = await fetchAPI<DBReservation>("/reservations", {
      method: "POST",
      body: JSON.stringify(reservation),
    });
    return convertDBReservationToReservation(dbReservation);
  },
  update: async (id: string, reservation: Partial<Reservation>) => {
    const dbReservation = await fetchAPI<DBReservation>(`/reservations/${id}`, {
      method: "PUT",
      body: JSON.stringify(reservation),
    });
    return convertDBReservationToReservation(dbReservation);
  },
};

function convertDBPinToPin(dbPin: DBPin): Pin {
  return {
    id: dbPin.id,
    roomId: dbPin.roomId,
    type: dbPin.type.toLowerCase() as "guest" | "staff" | "cleaner" | "service",
    code: dbPin.code,
    name: dbPin.name,
    email: dbPin.email || undefined,
    validFrom: typeof dbPin.validFrom === 'string' ? dbPin.validFrom : dbPin.validFrom.toISOString(),
    validTo: typeof dbPin.validTo === 'string' ? dbPin.validTo : dbPin.validTo.toISOString(),
    status: dbPin.status as "active" | "expired" | "pending" | "error",
    doors: (dbPin.doors as string[]) || [],
    assigner: dbPin.assigner || undefined,
    assigningTime: typeof dbPin.assigningTime === 'string' ? dbPin.assigningTime : dbPin.assigningTime.toISOString(),
  };
}

// Pins API
export const pinsAPI = {
  getAll: async () => {
    const dbPins = await fetchAPI<DBPin[]>("/pins");
    return dbPins.map(convertDBPinToPin);
  },
  getByRoom: async (roomId: string) => {
    const dbPins = await fetchAPI<DBPin[]>(`/pins/room/${roomId}`);
    return dbPins.map(convertDBPinToPin);
  },
  create: async (pin: Partial<Pin>) => {
    const dbPin = await fetchAPI<DBPin>("/pins", {
      method: "POST",
      body: JSON.stringify(pin),
    });
    return convertDBPinToPin(dbPin);
  },
  update: async (id: string, pin: Partial<Pin>) => {
    const dbPin = await fetchAPI<DBPin>(`/pins/${id}`, {
      method: "PUT",
      body: JSON.stringify(pin),
    });
    return convertDBPinToPin(dbPin);
  },
  delete: (id: string) => fetchAPI<void>(`/pins/${id}`, { method: "DELETE" }),
};

// Settings API
// Marketing/upsell campaigns (27/7)
export interface MarketingAudienceRow {
  reservationId: string;
  name: string;
  mobile: string | null;
  capsule: string;
  arrival: string;
  departure: string;
}
export interface MarketingCampaignDTO {
  id: string;
  label: string;
  enabled: boolean;
  sendTime: string;
  smsText: string | null;
  defaultSmsText: string;
  lastSentDate: string | null;
  preview: string;
  audienceCount: number;
  audience: MarketingAudienceRow[];
}
export interface MarketingSendRow {
  id: string;
  campaign: string;
  status: string;
  sentTo: string | null;
  body: string | null;
  error: string | null;
  trigger: string;
  sentAt: string;
  guestName: string;
}
export interface MarketingSendResult {
  ok: boolean;
  dryRun?: boolean;
  test?: boolean;
  to?: string;
  body?: string;
  recipients?: Array<{ reservationId: string; name: string; mobile: string; body: string }>;
  sent?: Array<{ reservationId: string; name: string; mobile: string }>;
  failed?: Array<{ reservationId: string; name: string; mobile: string; error: string }>;
  skipped?: Array<{ reservationId: string; reason: string }>;
  error?: string;
}
export interface MarketingHistoryDay {
  day: string; // yyyy-MM-dd, hotel time
  ecSent: number;
  lcSent: number;
  failed: number;
  ecPurchases: number;
  lcPurchases: number;
  revenue: number;
}
export const marketingAPI = {
  campaigns: () => fetchAPI<{ campaigns: MarketingCampaignDTO[] }>("/marketing/campaigns"),
  sends: () => fetchAPI<{ sends: MarketingSendRow[] }>("/marketing/sends"),
  history: (days: number) => fetchAPI<{ days: MarketingHistoryDay[] }>(`/marketing/history?days=${days}`),
  send: (campaign: string, opts?: { dryRun?: boolean; testTo?: string }) =>
    fetchAPI<MarketingSendResult>("/marketing/send", {
      method: "POST",
      body: JSON.stringify({ campaign, ...(opts || {}) }),
    }),
};

export const settingsAPI = {
  getAll: () => fetchAPI<Setting[]>("/settings"),
  getOne: (key: string) => fetchAPI<Setting>(`/settings/${key}`),
  update: (key: string, value: string) => fetchAPI<Setting>(`/settings/${key}`, {
    method: "PUT",
    body: JSON.stringify({ value }),
  }),
};

// Arrivals API — today's arrival status (the live version of the hourly report email)
export interface ArrivalRow {
  reservationId: string;
  guestName: string;
  room: string;
  hk: { label: string; color: string };
  code: string | null;
  msgSent: boolean;
  status: { priority: number; text: string; color: string };
  reason: string;
  mewsUrl: string | null;
  earlyCheckinFrom: string | null;
  lateCheckoutUntil: string | null;
}

export interface ArrivalsData {
  hotelName: string;
  tz: string;
  reportDate: string;
  reportDateLabel: string;
  generatedAt: string;
  generatedAtLabel: string;
  rows: ArrivalRow[];
  counts: {
    total: number;
    viaCode: number;
    manual: number;
    notArrived: number;
    noShow: number;
    mewsRejected: number;
    awaitingPayment: number;
    hourly?: number;
    /** Extra cleaning tasks: time bookings + late checkouts freeing capsules dirty outside the morning round */
    cleaning?: number;
  };
  urgentReasons: string[];
  doorGaps: Array<{ lockName: string; guestName: string; code: string; reason: string }>;
  offlineDoors: string[];
  autoRepairedCount: number;
  auditRan: boolean;
  auditAt: string | null;
  upsells: { lines: Array<{ kind: string; guestName: string; time: string; amount: string }>; totals: string };
  blocks: Array<{ roomLabel: string; typeLabel: string; start: string; end: string; name: string | null }>;
  repairIntervalMinutes: number;
}

export const arrivalsAPI = {
  get: (date?: string, key?: string) => {
    const params = new URLSearchParams();
    if (date) params.set("date", date);
    if (key) params.set("key", key);
    const qs = params.toString();
    return fetchAPI<ArrivalsData>(`/arrivals${qs ? `?${qs}` : ""}`);
  },
};

// Logs API
export const logsAPI = {
  getAll: (limit?: number) => fetchAPI<Log[]>(`/logs${limit ? `?limit=${limit}` : ""}`),
  getByReservation: (reservationId: string) => fetchAPI<Log[]>(`/logs/reservation/${reservationId}`),
  create: (log: Partial<Log>) => fetchAPI<Log>("/logs", {
    method: "POST",
    body: JSON.stringify(log),
  }),
};

// Reservation Logs API
export const reservationLogsAPI = {
  getByReservation: (reservationId: string) => fetchAPI<ReservationLog[]>(`/reservation-logs/${reservationId}`),
  create: (log: Partial<ReservationLog>) => fetchAPI<ReservationLog>("/reservation-logs", {
    method: "POST",
    body: JSON.stringify(log),
  }),
};

// Lock Devices API
export const lockDevicesAPI = {
  getAll: () => fetchAPI<LockDevice[]>("/lock-devices"),
  sync: () => fetchAPI<{ success: boolean; imported: number; updated: number; removed: number; totalLocks: number; locks: string[] }>("/sync-ttlocks", {
    method: "POST",
  }),
  update: (id: string, data: Partial<LockDevice>) => fetchAPI<LockDevice>(`/lock-devices/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  }),
  mapToRoom: (deviceId: string, roomId: string | null) => fetchAPI<{ success: boolean; previousRoom?: string; newRoom?: string }>(`/lock-devices/${deviceId}/map-to-room`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roomId }),
  }),
};

// QR Codes API
export const qrCodesAPI = {
  getByRoom: (roomId: string) => fetchAPI<QrCode[]>(`/qr-codes/room/${roomId}`),
  create: (code: Partial<QrCode>) => fetchAPI<QrCode>("/qr-codes", {
    method: "POST",
    body: JSON.stringify(code),
  }),
};

// Room Lock Assignments API
export interface RoomLockAssignmentWithDetails extends RoomLockAssignment {
  room?: DBRoom;
  lockDevice?: LockDevice;
}

export const roomLockAssignmentsAPI = {
  getAll: () => fetchAPI<RoomLockAssignmentWithDetails[]>("/room-lock-assignments"),
  getByRoom: (roomId: string) => fetchAPI<RoomLockAssignmentWithDetails[]>(`/room-lock-assignments/room/${roomId}`),
  getByDevice: (deviceId: string) => fetchAPI<RoomLockAssignmentWithDetails[]>(`/room-lock-assignments/device/${deviceId}`),
  create: (assignment: { roomId: string; lockDeviceId: string; assignmentType: string; accessScope?: string | null }) => 
    fetchAPI<RoomLockAssignment>("/room-lock-assignments", {
      method: "POST",
      body: JSON.stringify(assignment),
    }),
  createBulk: (assignments: { roomId: string; lockDeviceId: string; assignmentType: string; accessScope?: string | null }[]) =>
    fetchAPI<{ created: number; assignments: RoomLockAssignment[] }>("/room-lock-assignments/bulk", {
      method: "POST",
      body: JSON.stringify({ assignments }),
    }),
  delete: (id: string) => fetchAPI<void>(`/room-lock-assignments/${id}`, { method: "DELETE" }),
  deleteBulk: (ids: string[]) =>
    fetchAPI<{ deleted: number }>("/room-lock-assignments/bulk-delete", {
      method: "POST",
      body: JSON.stringify({ ids }),
    }),
  deleteByRoomAndDevice: (roomId: string, deviceId: string) => 
    fetchAPI<void>(`/room-lock-assignments/room/${roomId}/device/${deviceId}`, { method: "DELETE" }),
};

// Admin API (Owner-level access)
export interface AdminLock {
  lockId: number;
  name: string;
  alias: string;
  mac: string;
  battery: number;
  date: number;
  groupId?: number;
  groupName?: string | null;
}

export interface AdminGroup {
  groupId: number;
  groupName: string;
}

export interface AdminTenant {
  id: string;
  name: string;
  slug: string;
  pmsType: string | null;
  pmsEnterpriseId: string | null;
  apiKey: string;
  active: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AdminTenantStats {
  reservationCount: number;
  activeReservationCount: number;
  pinCount: number;
  activePinCount: number;
  roomCount: number;
  lockDeviceCount: number;
  lastError: { message: string; timestamp: string } | null;
}

export interface AdminTenantCredentials {
  mews: {
    environment: string | null;
    clientToken: string | null;
    accessToken: string | null;
  };
  ttlock: {
    username: string | null;
    password: string | null;
    accessToken: string | null;
    region: string | null;
  };
  notifications: {
    smsEnabled: boolean;
    emailEnabled: boolean;
  };
  other: { key: string; value: string; encrypted: boolean }[];
}

// Admin session token storage
let adminToken: string | null = null;

// Helper for admin API calls
async function adminFetch<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  if (!adminToken) {
    throw new Error("Admin authentication required");
  }
  const response = await fetch(`${API_BASE}/admin${endpoint}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${adminToken}`,
      ...options.headers,
    },
  });
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: "Request failed" }));
    const errorMessage = errorData.details 
      ? `${errorData.error}: ${errorData.details}` 
      : (errorData.error || `HTTP ${response.status}`);
    throw new Error(errorMessage);
  }
  return response.json();
}

export const adminAPI = {
  setToken: (token: string) => {
    adminToken = token;
  },
  clearToken: () => {
    adminToken = null;
  },
  getToken: () => adminToken,
  getAllLocks: async () => {
    return adminFetch<{ success: boolean; total: number; groups: AdminGroup[]; locks: AdminLock[] }>("/ttlock/locks");
  },
  
  // Tenant management
  getAllTenants: async () => {
    return adminFetch<{ success: boolean; tenants: AdminTenant[] }>("/tenants");
  },
  getTenant: async (id: string) => {
    return adminFetch<{ success: boolean; tenant: AdminTenant }>(`/tenants/${id}`);
  },
  getTenantStats: async (id: string) => {
    return adminFetch<{ success: boolean; stats: AdminTenantStats }>(`/tenants/${id}/stats`);
  },
  getTenantCredentials: async (id: string) => {
    return adminFetch<{ success: boolean; credentials: AdminTenantCredentials }>(`/tenants/${id}/credentials`);
  },
  createTenant: async (data: { name: string; slug: string; pmsType?: string }) => {
    return adminFetch<{ success: boolean; tenant: AdminTenant }>("/tenants", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },
  updateTenant: async (id: string, data: Partial<AdminTenant>) => {
    return adminFetch<{ success: boolean; tenant: AdminTenant }>(`/tenants/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
  },
  deleteTenant: async (id: string) => {
    return adminFetch<{ success: boolean; message: string }>(`/tenants/${id}`, {
      method: "DELETE",
    });
  },
  
  // Invitation management
  getAllInvitations: async () => {
    return adminFetch<{ success: boolean; invitations: AdminInvitation[] }>("/invitations");
  },
  createInvitation: async (data: { tenantId: string; email: string; sendEmail?: boolean }) => {
    return adminFetch<{ success: boolean; invitation: AdminInvitation; emailSent: boolean; setupUrl: string }>("/invitations", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },
  deleteInvitation: async (id: string) => {
    return adminFetch<{ success: boolean }>(`/invitations/${id}`, {
      method: "DELETE",
    });
  },
};

export interface AdminInvitation {
  id: string;
  tenantId: string;
  token: string;
  email: string;
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
}

export async function validateInvitationToken(token: string): Promise<{
  valid: boolean;
  tenantId?: string;
  tenantName?: string;
  tenantSlug?: string;
  email?: string;
  error?: string;
}> {
  const response = await fetch(`${API_BASE}/invitations/validate/${token}`);
  return response.json();
}

export async function useInvitationToken(token: string): Promise<{
  success: boolean;
  tenantId?: string;
  error?: string;
}> {
  const response = await fetch(`${API_BASE}/admin/invitations/${token}/accept`, {
    method: "POST",
  });
  return response.json();
}

// ── Hourly capsule rentals (standalone, outside MEWS) ──────────────────────

export interface HourlyBookingDTO {
  id: string;
  roomId: string;
  guestName: string;
  guestEmail: string | null;
  guestPhone: string | null;
  startAt: string;
  endAt: string;
  status: string;
  pinCode: string | null;
  lockKeyIds: { lockDeviceId: string; ttlockId: string; keyId: string; lockName: string }[];
  amount: string | null;
  currency: string | null;
  codeDeliveredAt: string | null;
  /** Null on a confirmed booking = the capsule is NOT blocked in MEWS (oversell risk). */
  mewsReservationId: string | null;
  createdAt: string;
}

export interface DayAvailabilityDTO {
  date: string;
  dayStart: string;
  dayEnd: string;
  rows: Array<{
    roomId: string;
    /** All space ids of the physical capsule (twins included) — pool toggling flips them all. */
    roomIds: string[];
    label: string;
    hourlyPool: boolean;
    free: Array<{ from: string; to: string }>;
    occupied: Array<{ from: string; to: string; cause: "guest" | "hourly" | "hourly-pending" | "block"; label?: string }>;
    /** MEWS housekeeping state: Dirty | Clean | Inspected | OutOfService | OutOfOrder. Null when unknown. */
    state: string | null;
    /** Capsule position: "Upper" | "Lower". Null when unknown. */
    floor: string | null;
  }>;
  unassignedCount: number;
  blocksUnknown: boolean;
  statesUnknown: boolean;
}

export const hourlyAPI = {
  getBookings: () => fetchAPI<HourlyBookingDTO[]>("/hourly/bookings"),
  getAvailabilityOverview: (date: string) =>
    fetchAPI<DayAvailabilityDTO>(`/hourly/availability-overview?date=${encodeURIComponent(date)}`),
  checkAvailability: (startAt: string, endAt: string) =>
    fetchAPI<{ free: { id: string; name: string; label: string | null }[]; count: number }>(
      "/hourly/availability",
      { method: "POST", body: JSON.stringify({ startAt, endAt }) },
    ),
  createBooking: (input: {
    guestName: string;
    guestEmail?: string;
    guestPhone?: string;
    startAt: string;
    endAt: string;
    roomId?: string;
  }) =>
    fetchAPI<{ booking: HourlyBookingDTO; warnings: string[] }>("/hourly/bookings", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  cancelBooking: (id: string) =>
    fetchAPI<{ revoked: number; failed: string[] }>(`/hourly/bookings/${id}/cancel`, { method: "POST" }),
  getPricing: () =>
    fetchAPI<{ perHour: number; currency: string; mewsEnabled: boolean }>("/hourly/pricing"),
  createBookingWithPayment: (input: {
    guestName: string;
    guestEmail?: string;
    guestPhone?: string;
    startAt: string;
    endAt: string;
    roomId: string;
    amount?: string;
    currency?: string;
    skipPayment?: boolean;
  }) =>
    fetchAPI<{
      mode: "confirmed" | "pending_payment";
      bookingId: string;
      code?: string | null;
      warnings?: string[];
      paymentUrl?: string;
      amount?: number;
      currency?: string;
    }>("/hourly/bookings/with-payment", { method: "POST", body: JSON.stringify(input) }),
  getBookingStatus: (id: string) =>
    fetchAPI<{ status: string; code: string | null; mewsReservationId: string | null; warnings: string[] }>(
      `/hourly/bookings/${id}/status`,
    ),
  // Pool toggling reuses the existing rooms update endpoint (hourlyPool is part of the room schema)
  getRawRooms: () => fetchAPI<DBRoom[]>("/rooms"),
  setPool: (roomId: string, hourlyPool: boolean) =>
    fetchAPI<DBRoom>(`/rooms/${roomId}`, { method: "PUT", body: JSON.stringify({ hourlyPool }) }),
};
