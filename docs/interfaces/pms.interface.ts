/**
 * PMS Adapter Interface
 * 
 * All Property Management System adapters must implement this interface.
 * This ensures consistent behavior across MEWS, Opera, Cloudbeds, etc.
 */

export interface PMSReservation {
  pmsId: string;
  reservationNumber: string;
  firstName: string;
  lastName: string;
  email: string | null;
  mobile: string | null;
  arrival: Date;
  departure: Date;
  status: PMSReservationStatus;
  roomId: string | null;
  roomName: string | null;
  groupId: string | null;
  adults: number;
  children: number;
  notes: string | null;
  source: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type PMSReservationStatus = 
  | 'Confirmed'
  | 'Checked-in'
  | 'Checked-out'
  | 'Cancelled'
  | 'Optional'
  | 'Enquired';

export interface PMSRoom {
  pmsId: string;
  name: string;
  type: string;
  floor: string | null;
  capacity: number;
  status: 'Available' | 'Occupied' | 'OutOfOrder' | 'OutOfService';
}

export interface PMSCustomer {
  pmsId: string;
  firstName: string;
  lastName: string;
  email: string | null;
  mobile: string | null;
  nationality: string | null;
  address: string | null;
}

export interface PMSPayment {
  pmsId: string;
  reservationId: string;
  amount: number;
  currency: string;
  status: 'Pending' | 'Completed' | 'Failed' | 'Refunded';
  method: string | null;
  createdAt: Date;
}

export interface PMSSyncResult {
  success: boolean;
  reservationsCreated: number;
  reservationsUpdated: number;
  reservationsDeleted: number;
  errors: string[];
  syncedAt: Date;
}

export interface PMSCheckInResult {
  success: boolean;
  pmsId: string;
  error?: string;
}

export interface PMSAdapterConfig {
  clientToken: string;
  accessToken: string;
  environment: 'demo' | 'production';
  serviceId?: string;
  webhookUrl?: string;
}

/**
 * PMS Adapter Interface
 * 
 * All PMS integrations must implement this interface.
 */
export interface IPMSAdapter {
  readonly providerName: string;
  readonly version: string;

  initialize(config: PMSAdapterConfig): Promise<void>;

  testConnection(): Promise<{ success: boolean; error?: string }>;

  getReservations(options: {
    startDate: Date;
    endDate: Date;
    states?: PMSReservationStatus[];
    updatedSince?: Date;
  }): Promise<PMSReservation[]>;

  getReservation(pmsId: string): Promise<PMSReservation | null>;

  getRooms(): Promise<PMSRoom[]>;

  getRoom(pmsId: string): Promise<PMSRoom | null>;

  getCustomer(pmsId: string): Promise<PMSCustomer | null>;

  getCustomers(pmsIds: string[]): Promise<PMSCustomer[]>;

  startReservation(pmsId: string): Promise<PMSCheckInResult>;

  cancelReservation(pmsId: string, reason?: string): Promise<{ success: boolean; error?: string }>;

  addReservationNote(pmsId: string, note: string): Promise<{ success: boolean; error?: string }>;

  getPayments(reservationId: string): Promise<PMSPayment[]>;

  createPaymentRequest(options: {
    reservationId: string;
    amount: number;
    currency: string;
    description?: string;
  }): Promise<{ success: boolean; paymentRequestId?: string; error?: string }>;
}

/**
 * PMS Adapter Factory
 * 
 * Creates the appropriate adapter based on provider type.
 */
export interface IPMSAdapterFactory {
  create(provider: 'mews' | 'opera' | 'cloudbeds', config: PMSAdapterConfig): IPMSAdapter;
  getSupportedProviders(): string[];
}
