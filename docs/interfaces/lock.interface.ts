/**
 * Lock Adapter Interface
 * 
 * All smart lock system adapters must implement this interface.
 * This ensures consistent behavior across TTLock, Salto, ASSA Abloy, etc.
 */

export interface LockDevice {
  providerId: string;
  name: string;
  type: 'room' | 'common' | 'entrance';
  batteryLevel: number | null;
  isOnline: boolean;
  firmwareVersion: string | null;
  lastSeen: Date | null;
  metadata: Record<string, unknown>;
}

export interface Passcode {
  providerId: string;
  code: string;
  name: string;
  type: 'permanent' | 'timed' | 'one-time' | 'recurring';
  validFrom: Date;
  validTo: Date;
  status: 'active' | 'expired' | 'deleted' | 'disabled';
  createdAt: Date;
}

export interface PasscodeCreateOptions {
  lockId: string;
  code: string;
  name: string;
  validFrom: Date;
  validTo: Date;
  type?: 'timed' | 'permanent';
}

export interface PasscodeCreateResult {
  success: boolean;
  providerId?: string;
  error?: string;
}

export interface PasscodeDeleteResult {
  success: boolean;
  error?: string;
}

export interface RemoteUnlockResult {
  success: boolean;
  error?: string;
  latencyMs?: number;
}

export interface LockSyncResult {
  success: boolean;
  locksFound: number;
  locksUpdated: number;
  errors: string[];
  syncedAt: Date;
}

export interface EKeyCreateOptions {
  lockId: string;
  recipientUsername: string;
  name: string;
  validFrom: Date;
  validTo: Date;
  remoteUnlockEnabled: boolean;
}

export interface EKeyCreateResult {
  success: boolean;
  keyId?: string;
  error?: string;
}

export interface LockAdapterConfig {
  region: 'eu' | 'cn' | 'us';
  clientId: string;
  clientSecret: string;
  username?: string;
  password?: string;
  accessToken?: string;
  refreshToken?: string;
}

export interface LockCredentials {
  owner: {
    username: string;
    password: string;
  };
  hotel: {
    username: string;
    password: string;
  };
}

/**
 * Lock Adapter Interface
 * 
 * All lock system integrations must implement this interface.
 */
export interface ILockAdapter {
  readonly providerName: string;
  readonly version: string;

  initialize(config: LockAdapterConfig): Promise<void>;

  testConnection(): Promise<{ success: boolean; error?: string }>;

  getLocks(): Promise<LockDevice[]>;

  getLock(providerId: string): Promise<LockDevice | null>;

  syncLocks(): Promise<LockSyncResult>;

  createPasscode(options: PasscodeCreateOptions): Promise<PasscodeCreateResult>;

  deletePasscode(lockId: string, passcodeId: string): Promise<PasscodeDeleteResult>;

  getPasscodes(lockId: string): Promise<Passcode[]>;

  remoteUnlock(lockId: string): Promise<RemoteUnlockResult>;

  createEKey(options: EKeyCreateOptions): Promise<EKeyCreateResult>;

  deleteEKey(keyId: string): Promise<{ success: boolean; error?: string }>;

  getUnlockRecords(lockId: string, options: {
    startDate: Date;
    endDate: Date;
    limit?: number;
  }): Promise<Array<{
    lockId: string;
    method: 'passcode' | 'ekey' | 'fingerprint' | 'card' | 'remote' | 'manual';
    userId?: string;
    passcode?: string;
    timestamp: Date;
    success: boolean;
  }>>;

  getBatteryLevel(lockId: string): Promise<number | null>;

  refreshToken(): Promise<{ success: boolean; expiresAt?: Date; error?: string }>;
}

/**
 * Lock Adapter Factory
 * 
 * Creates the appropriate adapter based on provider type.
 */
export interface ILockAdapterFactory {
  create(provider: 'ttlock' | 'salto' | 'assa', config: LockAdapterConfig): ILockAdapter;
  getSupportedProviders(): string[];
}

/**
 * Lock Gateway Service
 * 
 * High-level service that orchestrates lock operations across multiple locks.
 */
export interface ILockGateway {
  pushPasscodeToLocks(options: {
    lockIds: string[];
    code: string;
    name: string;
    validFrom: Date;
    validTo: Date;
  }): Promise<{
    success: boolean;
    results: Array<{
      lockId: string;
      success: boolean;
      providerId?: string;
      error?: string;
    }>;
  }>;

  deletePasscodeFromLocks(options: {
    locks: Array<{ lockId: string; passcodeId: string }>;
  }): Promise<{
    success: boolean;
    results: Array<{
      lockId: string;
      success: boolean;
      error?: string;
    }>;
  }>;

  unlockDoor(lockId: string, audit: {
    userId?: string;
    reservationId?: string;
    reason: string;
  }): Promise<RemoteUnlockResult>;
}
