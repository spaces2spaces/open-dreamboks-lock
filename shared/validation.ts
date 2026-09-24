import { z } from "zod";

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const adminPinSchema = z.object({
  pin: z.string().min(1),
});

export const adminLoginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export const boardingPassLookupSchema = z.object({
  reservationNumber: z.string().min(1),
  lastName: z.string().min(1),
  // Optional hotel slug so the unscoped /boarding-pass page can target a non-default tenant.
  hotelSlug: z.string().optional(),
});

export const unlockSchema = z.object({
  reservationNumber: z.string().min(1),
  lastName: z.string().min(1),
  lockId: z.string().min(1),
});

export const qrCodeDataSchema = z.object({
  reservationNumber: z.string().min(1),
  lastName: z.string().min(1),
  lockId: z.string().min(1),
});

export const settingUpdateSchema = z.object({
  value: z.string(),
  // Explicit confirmation phrase required by destructive setting changes
  // (mews_environment switch wipes ALL MEWS data for the tenant).
  confirm: z.string().optional(),
});

export const featureFlagUpdateSchema = z.object({
  enabled: z.boolean(),
});

export const roomLockAssignmentSchema = z.object({
  roomId: z.string().min(1),
  lockDeviceId: z.string().min(1),
  assignmentType: z.string().optional(),
  accessScope: z.string().nullable().optional(),
});

export const bulkAssignmentSchema = z.object({
  assignments: z.array(z.object({
    roomId: z.string().min(1),
    lockDeviceId: z.string().min(1),
    assignmentType: z.string().optional(),
    accessScope: z.string().nullable().optional(),
  })).min(1),
});

export const bulkDeleteSchema = z.object({
  ids: z.array(z.string().min(1)).min(1),
});

export const savePersonalEmailSchema = z.object({
  reservationId: z.string().min(1),
  personalEmail: z.string().email(),
  pin: z.string().min(1),
  guestProfile: z.any().optional(),
});

export const sendBoardingPassEmailSchema = z.object({
  reservationNumber: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email(),
});

export const resendBoardingPassSchema = z.object({
  reservationId: z.string().min(1),
  pin: z.string().min(1),
});

export const lookupByPinSchema = z.object({
  pin: z.string().length(4),
  hotelSlug: z.string().optional(),
});

export const createTenantSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1),
  pmsType: z.string().optional(),
  pmsEnterpriseId: z.string().optional(),
  apiKey: z.string().optional(),
  active: z.boolean().optional(),
  metadata: z.any().optional(),
});

export const createInvitationSchema = z.object({
  tenantId: z.string().min(1),
  email: z.string().email(),
  sendEmail: z.boolean().optional(),
});

export const createHotelUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  name: z.string().min(1),
  role: z.string().optional(),
});

export const testEmailSchema = z.object({
  email: z.string().email(),
  guestName: z.string().optional(),
  pin: z.string().optional(),
});

export const sendCheckinEmailSchema = z.object({
  email: z.string().email(),
  guestName: z.string().optional(),
  checkInUrl: z.string().min(1),
  reservationId: z.string().optional(),
});
