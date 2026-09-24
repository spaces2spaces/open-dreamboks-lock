import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, boolean, timestamp, jsonb, unique, index, uniqueIndex, bigserial } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";

// Tenants table for multi-tenancy
export const tenants = pgTable("tenants", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  pmsType: text("pms_type"),
  pmsEnterpriseId: text("pms_enterprise_id"),
  apiKey: text("api_key").notNull().unique(),
  active: boolean("active").notNull().default(true),
  metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertTenantSchema = createInsertSchema(tenants).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertTenant = z.infer<typeof insertTenantSchema>;
export type Tenant = typeof tenants.$inferSelect;

// Hotel users for authentication
export const hotelUsers = pgTable("hotel_users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(),
  name: text("name").notNull(),
  role: text("role").notNull().default("staff"),
  active: boolean("active").notNull().default(true),
  lastLoginAt: timestamp("last_login_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  tenantIdx: index('hotel_users_tenant_idx').on(table.tenantId),
  emailUnique: unique('hotel_users_email_unique').on(table.email),
}));

export const insertHotelUserSchema = createInsertSchema(hotelUsers).omit({
  id: true,
  createdAt: true,
  lastLoginAt: true,
});

export type InsertHotelUser = z.infer<typeof insertHotelUserSchema>;
export type HotelUser = typeof hotelUsers.$inferSelect;

export const vendorInvitations = pgTable("vendor_invitations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  token: text("token").notNull().unique(),
  email: text("email").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  tenantIdx: index('vendor_invitations_tenant_idx').on(table.tenantId),
  tokenIdx: index('vendor_invitations_token_idx').on(table.token),
}));

export const insertVendorInvitationSchema = createInsertSchema(vendorInvitations).omit({
  id: true,
  createdAt: true,
});

export type InsertVendorInvitation = z.infer<typeof insertVendorInvitationSchema>;
export type VendorInvitation = typeof vendorInvitations.$inferSelect;

export const rooms = pgTable("rooms", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: 'restrict' }),
  name: text("name").notNull(),
  type: text("type").notNull(),
  beds: integer("beds").notNull().default(1),
  pmsStatus: text("pms_status").notNull().default("unmapped"),
  pmsId: text("pms_id"),
  battery: integer("battery").notNull().default(100),
  floor: text("floor"),
  building: text("building"),
  ordering: integer("ordering"),
  commonAreas: jsonb("common_areas").notNull().default(sql`'[]'::jsonb`),
  isDreamBoks: boolean("is_dream_boks").notNull().default(false),
  ttlockId: text("ttlock_id"),
  spaceCategory: text("space_category"),
  label: text("label"),
  // Hourly-rental pool: rooms flagged true are sold by the hour OUTSIDE MEWS
  // (carved out of MEWS inventory operator-side, so no double-booking risk).
  hourlyPool: boolean("hourly_pool").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  tenantIdx: index('rooms_tenant_idx').on(table.tenantId),
  tenantPmsIdUnique: unique('rooms_tenant_pms_id_unique').on(table.tenantId, table.pmsId),
  // NOTE: ttlockId is NOT unique - multiple MEWS Spaces can share the same TTLock (dormitory-style)
}));

export const insertRoomSchema = createInsertSchema(rooms).omit({
  id: true,
  createdAt: true,
});

export type InsertRoom = z.infer<typeof insertRoomSchema>;
export type Room = typeof rooms.$inferSelect;

export const commonAreas = pgTable("common_areas", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: 'restrict' }),
  name: text("name").notNull(),
  battery: integer("battery").notNull().default(100),
  floor: text("floor"),
  building: text("building"),
  accessScope: text("access_scope").notNull().default("universal"),
  ttlockId: text("ttlock_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  tenantIdx: index('common_areas_tenant_idx').on(table.tenantId),
  tenantTtlockIdUnique: unique('common_areas_tenant_ttlock_id_unique').on(table.tenantId, table.ttlockId),
}));

export const insertCommonAreaSchema = createInsertSchema(commonAreas).omit({
  id: true,
  createdAt: true,
});

export type InsertCommonArea = z.infer<typeof insertCommonAreaSchema>;
export type CommonArea = typeof commonAreas.$inferSelect;

export const reservations = pgTable("reservations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: 'restrict' }),
  email: text("email"),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  arrival: timestamp("arrival").notNull(),
  departure: timestamp("departure").notNull(),
  pmsId: text("pms_id").notNull(),
  extId: text("ext_id"),
  roomId: text("room_id").references(() => rooms.id, { onDelete: 'set null' }),
  adults: integer("adults").notNull().default(1),
  children: integer("children").notNull().default(0),
  status: text("status").notNull().default("Confirmed"),
  room: text("room"),
  bed: text("bed"),
  price: text("price"),
  currency: text("currency"),
  owing: text("owing"),
  mobile: text("mobile"),
  confirmationCode: text("confirmation_code"),
  // OTA / channel-manager booking references from MEWS (ChannelNumber = the
  // number the guest knows from Booking.com/Hostelworld/Expedia etc.,
  // ChannelManagerNumber = the channel manager's own id). Used by the kiosk
  // "Find my door code" lookup so a guest can type the number on their OTA
  // confirmation instead of a (possibly misspelled) name.
  channelNumber: text("channel_number"),
  channelManagerNumber: text("channel_manager_number"),
  generatedPin: text("generated_pin"),
  groupName: text("group_name"),
  requestedCategory: text("requested_category"),
  spaceCategory: text("space_category"),
  assignedSpace: text("assigned_space"),
  rateName: text("rate_name"),
  avgRate: text("avg_rate"),
  totalAmount: text("total_amount"),
  origin: text("origin"),
  reservationSource: text("reservation_source"),
  notificationSent: boolean("notification_sent").notNull().default(false),
  preCheckinToken: text("pre_checkin_token").unique(),
  preCheckinStatus: text("pre_checkin_status").notNull().default("pending"),
  personalEmail: text("personal_email"),
  preferredChannel: text("preferred_channel"),
  preCheckinEmailSent: boolean("pre_checkin_email_sent").notNull().default(false),
  // Count of pre-check-in send attempts that delivered nothing. Caps retries so an
  // unreachable guest (no email + failing SMS/WhatsApp) is not re-sent every minute.
  preCheckinAttempts: integer("pre_checkin_attempts").notNull().default(0),
  // Capsule door-code message (door_code_message_only mode): two at-most-once sends —
  // advance (23h before check-in) and reminder (1h before). Timestamps are the dedup markers.
  doorCodeSentAt: timestamp("door_code_sent_at"),
  doorCodeReminderSentAt: timestamp("door_code_reminder_sent_at"),
  doorCodeAttempts: integer("door_code_attempts").notNull().default(0),
  // Signature of the door-code content last delivered (pin|roomId|arrival|departure).
  // When it changes (date/room/pin change) the door-code job re-sends an updated message.
  doorCodeSig: text("door_code_sig"),
  mewsCustomerId: text("mews_customer_id"),
  mewsPinSyncedAt: timestamp("mews_pin_synced_at"),
  // Early check-in purchased at the kiosk: the moment access was granted.
  // Folded into buildValidityWindow as an earlier validFrom — only honored when
  // within 24h of the standard check-in time, so stale values after date
  // changes are inert. The guest's code digits never change.
  earlyCheckinFrom: timestamp("early_checkin_from"),
  // Paid late checkout: access keeps working until this time on the departure
  // day. Folded into buildValidityWindow as a later validTo (≤12h band, same
  // self-cleaning principle) and defers PIN revocation on MEWS's ~11:00 bulk
  // auto-checkout. The guest's code digits never change.
  lateCheckoutUntil: timestamp("late_checkout_until"),
  paymentVerifiedAt: timestamp("payment_verified_at"),
  codeDeliveredAt: timestamp("code_delivered_at"),
  pmsCheckinSource: text("pms_checkin_source"),
  guestSubmittedId: boolean("guest_submitted_id").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  tenantIdx: index('reservations_tenant_idx').on(table.tenantId),
  tenantPmsIdUnique: unique('reservations_tenant_pms_id_unique').on(table.tenantId, table.pmsId),
  tenantStatusArrivalIdx: index('reservations_tenant_status_arrival_idx').on(table.tenantId, table.status, table.arrival),
  tenantArrivalIdx: index('reservations_tenant_arrival_idx').on(table.tenantId, table.arrival),
  tenantDepartureIdx: index('reservations_tenant_departure_idx').on(table.tenantId, table.departure),
  preCheckinTokenIdx: index('reservations_pre_checkin_token_idx').on(table.preCheckinToken),
}));

export const insertReservationSchema = createInsertSchema(reservations).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertReservation = z.infer<typeof insertReservationSchema>;
export type Reservation = typeof reservations.$inferSelect;

export const pins = pgTable("pins", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: 'restrict' }),
  roomId: text("room_id").notNull(),
  reservationId: text("reservation_id"),
  type: text("type").notNull(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  email: text("email"),
  validFrom: timestamp("valid_from").notNull(),
  validTo: timestamp("valid_to").notNull(),
  // OFFICIAL STATUS SET — every value must be covered by the repair scopes
  // (getRepairablePins, drift reconciler, door-code audit) or be terminal:
  //   pending       created, not yet pushed
  //   active        live on TTLock
  //   used          guest unlocked at least once (still repairable)
  //   replaced      superseded by a newer pin (terminal)
  //   inactive      manually deactivated via admin (terminal)
  //   cancelled     soft-archived after TTLock removal (terminal)
  //   delete_failed TTLock removal failed; retried by the repair job
  // Never introduce ad-hoc values: the legacy "deleted" status made pins
  // invisible to every repair mechanism (21/7 incident) and is now forbidden —
  // a unit test greps for new writers of it.
  status: text("status").notNull().default("pending"),
  doors: jsonb("doors").notNull().default(sql`'[]'::jsonb`),
  assigner: text("assigner"),
  assigningTime: timestamp("assigning_time").notNull().defaultNow(),
  ttlockKeyId: text("ttlock_key_id"),
  roomLockKeyIds: jsonb("room_lock_key_ids").notNull().default(sql`'[]'::jsonb`),
  commonAreaKeyIds: jsonb("common_area_key_ids").notNull().default(sql`'[]'::jsonb`),
  qrCodeData: jsonb("qr_code_data").notNull().default(sql`'[]'::jsonb`),
  ttlockQrCodeIds: jsonb("ttlock_qr_code_ids").notNull().default(sql`'{}'::jsonb`),
  firstUsedAt: timestamp("first_used_at"),
  activatedAt: timestamp("activated_at"),
  // Orphan-cleanup observation state: {count, firstSeenAt, lastSeenAt} tracking
  // consecutive hourly runs where this pin's keys were missing from a verified-
  // online lock. Only terminal/expired pins are ever archived, and only after
  // 3 observations spanning >= 2 hours — a single gateway flap must never kill
  // a code. Nullable: absent means "no orphan signal seen".
  orphanObservations: jsonb("orphan_observations"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  tenantIdx: index('pins_tenant_idx').on(table.tenantId),
  reservationIdx: index('pins_reservation_idx').on(table.reservationId),
  tenantRoomStatusIdx: index('pins_tenant_room_status_idx').on(table.tenantId, table.roomId, table.status),
  tenantStatusIdx: index('pins_tenant_status_idx').on(table.tenantId, table.status),
}));

export const insertPinSchema = createInsertSchema(pins).omit({
  id: true,
  createdAt: true,
  assigningTime: true,
  firstUsedAt: true,
});

export type InsertPin = z.infer<typeof insertPinSchema>;
export type Pin = typeof pins.$inferSelect;

export const ekeys = pgTable("ekeys", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: 'restrict' }),
  reservationId: text("reservation_id").notNull(),
  lockDeviceId: text("lock_device_id").notNull(),
  ttlockKeyId: integer("ttlock_key_id").notNull(),
  lockName: text("lock_name").notNull(),
  lockType: text("lock_type").notNull(),
  validFrom: timestamp("valid_from").notNull(),
  validTo: timestamp("valid_to").notNull(),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  tenantIdx: index('ekeys_tenant_idx').on(table.tenantId),
  reservationIdx: index('ekeys_reservation_idx').on(table.reservationId),
  lockDeviceIdx: index('ekeys_lock_device_idx').on(table.lockDeviceId),
}));

export const insertEkeySchema = createInsertSchema(ekeys).omit({
  id: true,
  createdAt: true,
});

export type InsertEkey = z.infer<typeof insertEkeySchema>;
export type Ekey = typeof ekeys.$inferSelect;

export const logs = pgTable("logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: 'restrict' }),
  timestamp: timestamp("timestamp").notNull().defaultNow(),
  level: text("level").notNull(),
  message: text("message").notNull(),
  source: text("source").notNull(),
  reservationId: text("reservation_id"),
  roomId: text("room_id"),
  metadata: jsonb("metadata"),
}, (table) => ({
  tenantIdx: index('logs_tenant_idx').on(table.tenantId),
  tenantReservationIdx: index('logs_tenant_reservation_idx').on(table.tenantId, table.reservationId),
  tenantTimestampIdx: index('logs_tenant_timestamp_idx').on(table.tenantId, table.timestamp),
}));

export const insertLogSchema = createInsertSchema(logs).omit({
  id: true,
  timestamp: true,
});

export type InsertLog = z.infer<typeof insertLogSchema>;
export type Log = typeof logs.$inferSelect;

export const settings = pgTable("settings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: 'restrict' }),
  key: text("key").notNull(),
  value: text("value").notNull(),
  encrypted: boolean("encrypted").notNull().default(false),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  tenantIdx: index('settings_tenant_idx').on(table.tenantId),
  tenantKeyUnique: unique('settings_tenant_key_unique').on(table.tenantId, table.key),
}));

export const insertSettingSchema = createInsertSchema(settings).omit({
  id: true,
  updatedAt: true,
});

export type InsertSetting = z.infer<typeof insertSettingSchema>;
export type Setting = typeof settings.$inferSelect;

export const lockDevices = pgTable("lock_devices", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: 'restrict' }),
  name: text("name").notNull(),
  mac: text("mac").notNull(),
  battery: integer("battery").notNull().default(100),
  lockType: text("lock_type").notNull().default("room"),
  doorName: text("door_name"),
  isLinked: boolean("is_linked").notNull().default(false),
  ttlockId: text("ttlock_id").notNull(),
  keyboardPwdVersion: integer("keyboard_pwd_version"),
  lastSync: timestamp("last_sync"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  tenantIdx: index('lock_devices_tenant_idx').on(table.tenantId),
  tenantMacUnique: unique('lock_devices_tenant_mac_unique').on(table.tenantId, table.mac),
  tenantTtlockIdUnique: unique('lock_devices_tenant_ttlock_id_unique').on(table.tenantId, table.ttlockId),
}));

export const insertLockDeviceSchema = createInsertSchema(lockDevices).omit({
  id: true,
  createdAt: true,
});

export type InsertLockDevice = z.infer<typeof insertLockDeviceSchema>;
export type LockDevice = typeof lockDevices.$inferSelect;

export const reservationLogs = pgTable("reservation_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: 'restrict' }),
  reservationId: text("reservation_id").notNull(),
  message: text("message").notNull(),
  timestamp: timestamp("timestamp").notNull().defaultNow(),
  type: text("type").notNull(),
  detail: text("detail"),
}, (table) => ({
  tenantIdx: index('reservation_logs_tenant_idx').on(table.tenantId),
}));

export const insertReservationLogSchema = createInsertSchema(reservationLogs).omit({
  id: true,
  timestamp: true,
});

export type InsertReservationLog = z.infer<typeof insertReservationLogSchema>;
export type ReservationLog = typeof reservationLogs.$inferSelect;

export const qrCodes = pgTable("qr_codes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: 'restrict' }),
  name: text("name").notNull(),
  assigner: text("assigner").notNull(),
  assigningTime: timestamp("assigning_time").notNull().defaultNow(),
  validityPeriod: text("validity_period").notNull(),
  status: text("status").notNull().default("Valid"),
  roomId: text("room_id"),
  ttlockKeyId: text("ttlock_key_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  tenantIdx: index('qr_codes_tenant_idx').on(table.tenantId),
}));

export const insertQrCodeSchema = createInsertSchema(qrCodes).omit({
  id: true,
  createdAt: true,
  assigningTime: true,
});

export type InsertQrCode = z.infer<typeof insertQrCodeSchema>;
export type QrCode = typeof qrCodes.$inferSelect;

// Sessions table for persistent auth sessions
export const sessions = pgTable("sessions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  token: text("token").notNull().unique(),
  userId: text("user_id"),          // null for admin sessions
  tenantId: text("tenant_id"),      // null for admin sessions
  role: text("role").notNull(),     // "hotel_user" | "admin"
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  tokenIdx: index('sessions_token_idx').on(table.token),
  expiresAtIdx: index('sessions_expires_at_idx').on(table.expiresAt),
}));

export const insertSessionSchema = createInsertSchema(sessions).omit({
  id: true,
  createdAt: true,
});

export type InsertSession = z.infer<typeof insertSessionSchema>;
export type Session = typeof sessions.$inferSelect;

// Room-Lock Assignments junction table
// Allows a room to be connected to multiple locks (room lock + common doors)
export const roomLockAssignments = pgTable("room_lock_assignments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: 'restrict' }),
  roomId: text("room_id").notNull().references(() => rooms.id, { onDelete: 'cascade' }),
  lockDeviceId: text("lock_device_id").notNull().references(() => lockDevices.id, { onDelete: 'cascade' }),
  assignmentType: text("assignment_type").notNull().default("room_lock"), // "room_lock" or "common_door"
  accessScope: text("access_scope"), // For common_door: "universal", "building", "floor", "manual"
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  tenantIdx: index('room_lock_assignments_tenant_idx').on(table.tenantId),
  roomIdx: index('room_lock_assignments_room_idx').on(table.roomId),
  lockDeviceIdx: index('room_lock_assignments_lock_device_idx').on(table.lockDeviceId),
  uniqueAssignment: unique('room_lock_assignments_unique').on(table.roomId, table.lockDeviceId),
}));

export const insertRoomLockAssignmentSchema = createInsertSchema(roomLockAssignments).omit({
  id: true,
  createdAt: true,
});

export type InsertRoomLockAssignment = z.infer<typeof insertRoomLockAssignmentSchema>;
export type RoomLockAssignment = typeof roomLockAssignments.$inferSelect;

// Hourly capsule rentals — standalone bookings sold by the hour OUTSIDE MEWS.
// Each row is its own source of truth (guest, exact window, code, lock keyIds);
// deliberately NOT mirrored into `pins` (reservation-less pins are removed by
// deleteOrphanedPins) and never touched by the MEWS reservation lifecycle.
export const hourlyBookings = pgTable("hourly_bookings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: 'restrict' }),
  roomId: text("room_id").notNull().references(() => rooms.id, { onDelete: 'restrict' }),
  guestName: text("guest_name").notNull(),
  guestEmail: text("guest_email"),
  guestPhone: text("guest_phone"),
  startAt: timestamp("start_at").notNull(),
  endAt: timestamp("end_at").notNull(),
  // pending_payment (hold, no code yet) | confirmed (paid/issued) | cancelled | expired
  status: text("status").notNull().default("pending_payment"),
  pinCode: text("pin_code"),
  // [{ lockDeviceId, ttlockId, keyId, lockName }] — every lock the code was pushed to
  lockKeyIds: jsonb("lock_key_ids").notNull().default(sql`'[]'::jsonb`),
  amount: text("amount"),
  currency: text("currency"),
  paymentProvider: text("payment_provider"),
  paymentRef: text("payment_ref"),
  paidAt: timestamp("paid_at"),
  codeDeliveredAt: timestamp("code_delivered_at"),
  // One-shot marker: the "your capsule is still held" payment reminder was
  // sent for this pending hold (3/8 — abandoned holds got no nudge at all).
  paymentReminderAt: timestamp("payment_reminder_at"),
  // Real MEWS reservation created for this hourly booking (admin flow):
  // pms reservation id, the MEWS customer used for payment + reservation, and
  // the checkout-signal idempotency marker (set once reservations/process
  // succeeded — or when we give up after endAt + 24h).
  mewsReservationId: text("mews_reservation_id"),
  mewsCustomerId: text("mews_customer_id"),
  mewsCheckedOutAt: timestamp("mews_checked_out_at"),
  // Set when the DURING-stay check-in signal ran (code verified used on a
  // lock → reservations/start; or the reservation was already Started).
  mewsCheckedInAt: timestamp("mews_checked_in_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  tenantIdx: index('hourly_bookings_tenant_idx').on(table.tenantId),
  roomIdx: index('hourly_bookings_room_idx').on(table.roomId),
  windowIdx: index('hourly_bookings_window_idx').on(table.tenantId, table.startAt, table.endAt),
  // NOTE: the DB additionally has an EXCLUSION constraint (applied manually,
  // drizzle can't express it): hourly_bookings_no_overlap EXCLUDE USING gist
  // (tenant_id WITH =, room_id WITH =, tsrange(start_at, end_at) WITH &&)
  // WHERE (status IN ('confirmed','pending_payment')) — requires btree_gist.
  // It makes double-booking impossible at the DB level; the service catches
  // the 23P01 violation and retries with the next free capsule.
}));

export const insertHourlyBookingSchema = createInsertSchema(hourlyBookings).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertHourlyBooking = z.infer<typeof insertHourlyBookingSchema>;
export type HourlyBooking = typeof hourlyBookings.$inferSelect;

// Early check-in purchases/waitlist made at the guest info kiosk. One row per
// attempt; at most one LIVE row (awaiting_inspection/pending_payment) per
// reservation (partial unique index). The guest's existing door code is never
// changed — completion only moves its validity window earlier.
export const earlyCheckins = pgTable("early_checkins", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: 'restrict' }),
  // Nullable + SET NULL (3/8): purchase rows are the permanent revenue/
  // conversion history and must SURVIVE reservation deletion — the old
  // CASCADE silently wiped all upsell history older than the reservation
  // retention window. Live flows always have a reservation; NULL only ever
  // appears on historical rows.
  reservationId: text("reservation_id").references(() => reservations.id, { onDelete: 'set null' }),
  roomId: text("room_id").references(() => rooms.id, { onDelete: 'set null' }),
  // early_checkin | late_checkout — same purchase/payment machinery, different
  // end of the stay. Late-checkout rows never use awaiting_inspection.
  kind: text("kind").notNull().default("early_checkin"),
  // awaiting_inspection (waitlist, email set) | pending_payment | completed | expired
  status: text("status").notNull(),
  email: text("email"),
  paymentRef: text("payment_ref"),
  amount: text("amount"),
  currency: text("currency"),
  hours: integer("hours"),
  notifiedAt: timestamp("notified_at"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  tenantStatusIdx: index('early_checkins_tenant_status_idx').on(table.tenantId, table.status),
  liveReservationUnique: uniqueIndex('early_checkins_live_reservation_kind_unique')
    .on(table.reservationId, table.kind)
    .where(sql`status IN ('awaiting_inspection','pending_payment')`),
}));

export type EarlyCheckin = typeof earlyCheckins.$inferSelect;

// Marketing/upsell SMS sends (27/7): one row per guest per campaign. The
// partial unique index is BOTH the per-stay dedupe and the race guard —
// runCampaign claims the slot (status='sent') BEFORE calling Twilio; a failed
// send is downgraded to 'failed', freeing the slot for a retry.
// reservationId is SET NULL on reservation deletion (4/8, same pattern as
// early_checkins): rows must survive the post-checkout reservation purge so
// the day-by-day campaign history keeps its counts. guestName is captured at
// send time for the same reason.
export const marketingSends = pgTable("marketing_sends", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: 'restrict' }),
  reservationId: text("reservation_id").references(() => reservations.id, { onDelete: 'set null' }),
  guestName: text("guest_name"),
  campaign: text("campaign").notNull(), // early_checkin_offer | late_checkout_offer
  status: text("status").notNull().default("sent"), // sent | failed
  sentTo: text("sent_to"), // actual number messaged (test overrides visible here)
  body: text("body"),
  error: text("error"),
  trigger: text("trigger").notNull().default("manual"), // manual | scheduled
  sentAt: timestamp("sent_at").notNull().defaultNow(),
}, (table) => ({
  tenantTimeIdx: index('marketing_sends_tenant_time_idx').on(table.tenantId, table.sentAt),
  reservationCampaignUnique: uniqueIndex('marketing_sends_reservation_campaign_unique')
    .on(table.reservationId, table.campaign)
    .where(sql`status = 'sent'`),
}));

export type MarketingSend = typeof marketingSends.$inferSelect;
export type InsertMarketingSend = typeof marketingSends.$inferInsert;

// Audit trail for cancelled reservations. Written outside the ORM (raw SQL),
// but declared here so `db:push` doesn't propose dropping the prod table.
// No FK constraints in prod — keep it that way to match.
export const cancellationAudit = pgTable("cancellation_audit", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  tenantId: text("tenant_id").notNull(),
  reservationId: text("reservation_id").notNull(),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  tenantTimeIdx: index('idx_cancellation_audit_tenant_time').on(table.tenantId, table.cancelledAt),
}));

export type CancellationAudit = typeof cancellationAudit.$inferSelect;
