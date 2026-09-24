import { createHash } from "crypto";

// In-memory cache for owner token (persists across requests)
let ownerTokenCache: {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
} | null = null;

// Mutex: if a token refresh is in-flight, concurrent callers wait for the same promise
let ownerTokenRefreshPromise: Promise<string> | null = null;

/**
 * Classify a TTLock error as a lock-connectivity ("offline") condition — mainly
 * error -3034 "Device not connected to network" (the lock's gateway is down).
 * These are transient, property-side network issues: the lock will accept
 * passcodes again once it reconnects. Callers should DEFER (retry later) and
 * must NOT treat the guest's PIN as failed — a single offline lock must never
 * break provisioning to the guest's other (reachable) locks.
 */
export function isLockOfflineError(message: string | null | undefined): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return (
    m.includes("-3034") ||
    m.includes("not connected to network") ||
    m.includes("device is offline") ||
    m.includes("lock is offline")
  );
}

interface TTLockPasscodeResponse {
  errcode: number;
  errmsg: string;
  keyboardPwdId?: number;
  keyboardPwd?: string;
}

interface TTLockTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  openid: string;
  scope: string;
}

interface TTLockListPasscodesResponse {
  errcode: number;
  errmsg: string;
  pages?: number;
  pageNo?: number;
  list?: Array<{
    keyboardPwdId: number;
    keyboardPwd: string;
    keyboardPwdName: string;
    keyboardPwdType: number;
    startDate: number;
    endDate: number;
    sendDate: number;
  }>;
}

interface TTLockLockStatusResponse {
  errcode?: number;
  errmsg?: string;
  electricQuantity: number;
  lockId: number;
  lockName: string;
  lockMac: string;
  lockAlias?: string;
  keyboardPwdVersion?: number;
}

interface TTLockListLocksResponse {
  errcode: number;
  errmsg: string;
  pageNo?: number;
  pageSize?: number;
  pages?: number;
  total?: number;
  list?: Array<{
    lockId: number;
    lockAlias: string;
    lockMac: string;
    electricQuantity: number;
    lockName: string;
    date: number;
    groupId?: number;
    groupName?: string;
  }>;
}

interface TTLockGroupsResponse {
  errcode: number;
  errmsg: string;
  pageNo?: number;
  pageSize?: number;
  pages?: number;
  total?: number;
  list?: Array<{
    groupId: number;
    groupName: string;
  }>;
}

interface TTLockUnlockRecord {
  lockId: number;
  recordType: number;
  success: number;
  username: string;
  keyboardPwd?: string;
  lockDate: number;
  serverDate: number;
}

interface TTLockUnlockRecordsResponse {
  errcode: number;
  errmsg: string;
  pageNo?: number;
  pageSize?: number;
  pages?: number;
  total?: number;
  list?: TTLockUnlockRecord[];
}

interface TTLockEkeyResponse {
  errcode: number;
  errmsg: string;
  keyId?: number;
}

interface TTLockQrCodeAddResponse {
  errcode: number;
  errmsg: string;
  qrCodeId?: number;
}

interface TTLockQrCodeDataResponse {
  errcode: number;
  errmsg: string;
  qrCodeData?: string;
  qrCodeContent?: string; // TTLock API uses this field name instead of qrCodeData
}

interface TTLockQrCodeListResponse {
  errcode: number;
  errmsg: string;
  list?: Array<{
    qrCodeId: number;
    qrCodeName: string;
    qrCodeType: number;
    startDate: number;
    endDate: number;
    createDate: number;
  }>;
}

export class TTLockClient {
  private baseUrl: string;
  private clientId: string;
  private accessToken: string;
  private region: "eu" | "cn";
  private useOwnerToken: boolean;

  // useOwnerToken: when true (default), requests transparently use the shared owner
  // account token if owner env credentials are present. This is correct for owner-level
  // operations (adding/removing passcodes — the owner is admin on every lock).
  // Pass false when the client MUST act as the specific hotel account, e.g. verifying
  // which locks a hotel actually has access to during sync. If this is left true there,
  // the access check runs as the owner and every hotel imports ALL locks (cross-tenant leak).
  // Per-lock write queue (module-shared: every client instance talks to the same
  // physical locks/gateways). The gateway→lock BLE link handles one command at a
  // time; concurrent adds/deletes to the same lock make TTLock return
  // -3037 "lock is busy". Serializing writes per lock with a minimum gap removes
  // that contention entirely — pushes to *different* locks still run in parallel.
  private static lockWriteChains = new Map<string, Promise<void>>();
  private static lockLastWriteAt = new Map<string, number>();
  private static readonly LOCK_WRITE_MIN_GAP_MS = 2500;

  private async withLockWriteQueue<T>(lockId: string, op: () => Promise<T>): Promise<T> {
    const prev = TTLockClient.lockWriteChains.get(lockId) ?? Promise.resolve();
    const run = prev.then(async () => {
      const last = TTLockClient.lockLastWriteAt.get(lockId) ?? 0;
      const wait = last + TTLockClient.LOCK_WRITE_MIN_GAP_MS - Date.now();
      if (wait > 0) await this.sleep(wait);
      try {
        return await op();
      } finally {
        TTLockClient.lockLastWriteAt.set(lockId, Date.now());
      }
    });
    TTLockClient.lockWriteChains.set(lockId, run.then(() => undefined, () => undefined));
    return run;
  }

  constructor(clientId: string, accessToken: string, region: "eu" | "cn" = "eu", useOwnerToken: boolean = true) {
    this.baseUrl = region === "eu"
      ? "https://euapi.ttlock.com"
      : "https://cnapi.ttlock.com";
    this.clientId = clientId;
    this.accessToken = accessToken;
    this.region = region;
    this.useOwnerToken = useOwnerToken;
  }

  static async getAccessToken(
    clientId: string,
    clientSecret: string,
    username: string,
    password: string,
    region: "eu" | "cn" = "eu"
  ): Promise<TTLockTokenResponse> {
    const baseUrl = region === "eu"
      ? "https://euapi.ttlock.com"
      : "https://cnapi.ttlock.com";

    const md5Password = createHash("md5").update(password).digest("hex");

    const params = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      username: username,
      password: md5Password,
      grant_type: "password",
    });

    const response = await fetch(`${baseUrl}/oauth2/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`TTLock OAuth error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    
    if (data.error) {
      throw new Error(`TTLock OAuth error: ${data.error} - ${data.error_description || "Authentication failed"}`);
    }
    
    if (data.errcode && data.errcode !== 0) {
      throw new Error(`TTLock OAuth error: ${data.errcode} - ${data.errmsg || "Unknown error"}`);
    }

    if (!data.access_token) {
      throw new Error("TTLock OAuth error: No access token received");
    }

    return data;
  }

  private async makeRequest<T>(endpoint: string, params: Record<string, any>): Promise<T> {
    // If owner credentials are set, always use a fresh (cached) owner token
    // so we never fail due to an expired stored token
    let activeToken = this.accessToken;
    if (this.useOwnerToken && process.env.TTLOCK_OWNER_USERNAME && process.env.TTLOCK_OWNER_PASSWORD && process.env.TTLOCK_CLIENT_ID) {
      try {
        activeToken = await getOwnerAccessToken(this.region);
        this.accessToken = activeToken; // keep in sync
      } catch {
        // fall back to stored token
      }
    }

    const allParams = new URLSearchParams({
      clientId: this.clientId,
      accessToken: activeToken,
      date: Date.now().toString(),
      ...params,
    });

    const url = `${this.baseUrl}${endpoint}`;
    console.log(`[TTLock API] ${endpoint}`);
    console.log(`[TTLock API] URL: ${url}`);
    
    // Mask sensitive params in logs
    const logParams = Object.fromEntries(allParams);
    if (logParams.accessToken) {
      logParams.accessToken = logParams.accessToken.substring(0, 8) + '***MASKED***';
    }
    console.log(`[TTLock API] Params:`, logParams);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: allParams,
      signal: AbortSignal.timeout(30_000), // 30s timeout — never hang indefinitely
    });

    console.log(`[TTLock API] Response status: ${response.status}`);

    if (!response.ok) {
      const error = await response.text();
      console.error(`[TTLock API] Error response:`, error.substring(0, 500));
      throw new Error(`TTLock API error: ${response.status} - ${error.substring(0, 200)}`);
    }

    const data = await response.json();
    
    const sanitizedData = { ...data };
    if (sanitizedData.adminPwd) sanitizedData.adminPwd = '***REDACTED***';
    if (sanitizedData.lockKey) sanitizedData.lockKey = '***REDACTED***';
    if (sanitizedData.featureValue) sanitizedData.featureValue = '***REDACTED***';
    if (sanitizedData.deletePwd) sanitizedData.deletePwd = '***REDACTED***';
    
    console.log(`[TTLock API] Response data:`, JSON.stringify(sanitizedData).substring(0, 500));
    
    if (data.errcode && data.errcode !== 0) {
      throw new Error(`TTLock API error: ${data.errcode} - ${data.errmsg}`);
    }

    return data;
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async addPasscode(
    lockId: string,
    passcode: string,
    name: string,
    options: {
      startDate: Date;
      endDate: Date;
      keyboardPwdVersion: number;
    }
  ): Promise<{ id: number; code: string }> {
    const { startDate, endDate, keyboardPwdVersion } = options;

    if (!/^\d{4,8}$/.test(passcode)) {
      throw new Error("Passcode must be 4-8 digits");
    }

    if (!startDate || !endDate) {
      throw new Error("startDate and endDate are required");
    }

    if (endDate <= startDate) {
      throw new Error("endDate must be after startDate");
    }

    const params = {
      lockId,
      keyboardPwd: passcode,
      keyboardPwdName: name,
      keyboardPwdVersion: keyboardPwdVersion.toString(),
      keyboardPwdType: "3",
      addType: "2", // 2 = Via Gateway (remote), 3 = Via Bluetooth
      startDate: startDate.getTime().toString(),
      endDate: endDate.getTime().toString(),
    };

    return this.withLockWriteQueue(lockId, () => this.addPasscodeInner(lockId, passcode, params));
  }

  private async addPasscodeInner(
    lockId: string,
    passcode: string,
    params: Record<string, string>
  ): Promise<{ id: number; code: string }> {
    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await this.makeRequest<TTLockPasscodeResponse>(
          "/v3/keyboardPwd/add",
          params
        );

        if (!response.keyboardPwdId) {
          throw new Error("Failed to create passcode: Invalid response from TTLock");
        }

        return {
          id: response.keyboardPwdId,
          code: passcode,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const isGatewayBusy = errorMessage.includes("-2011") || errorMessage.toLowerCase().includes("gateway busy");
        // -3037 "lock is busy": the gateway→lock BLE link was mid-operation.
        // With the per-lock queue this should be rare (keypad use can still
        // trigger it), and a short progressive backoff resolves it.
        const isLockBusy = errorMessage.includes("-3037");

        if ((isGatewayBusy || isLockBusy) && attempt < maxRetries) {
          console.log(`[TTLock] ${isLockBusy ? "Lock" : "Gateway"} busy, retrying (${attempt}/${maxRetries})...`);
          await this.sleep(attempt * 3000);
          continue;
        }

        const isDuplicate = errorMessage.includes("-3007") || errorMessage.toLowerCase().includes("already exists");
        if (isDuplicate) {
          console.log(`[TTLock] Passcode ${passcode} already exists on lock ${lockId} (-3007), looking up keyId...`);
          try {
            const existing = await this.listPasscodes(lockId);
            const match = existing.find(p => p.code === passcode);
            if (match) {
              console.log(`[TTLock] Found existing passcode ${passcode} on lock ${lockId} with keyId ${match.id}`);
              return { id: match.id, code: passcode };
            }
          } catch (listErr) {
            console.log(`[TTLock] Could not verify existing passcode: ${listErr}`);
          }
        }

        throw error;
      }
    }

    throw new Error("Failed to create passcode after 3 retries");
  }

  async deletePasscode(lockId: string, passcodeId: number, deleteType: number = 2): Promise<void> {
    return this.withLockWriteQueue(lockId, async () => {
      const maxRetries = 3;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          await this.makeRequest<TTLockPasscodeResponse>("/v3/keyboardPwd/delete", {
            lockId,
            keyboardPwdId: passcodeId.toString(),
            deleteType: deleteType.toString(),
          });
          return;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          const isGatewayBusy = errorMessage.includes("-2011") || errorMessage.toLowerCase().includes("gateway busy");
          const isLockBusy = errorMessage.includes("-3037");

          if ((isGatewayBusy || isLockBusy) && attempt < maxRetries) {
            console.log(`[TTLock] ${isLockBusy ? "Lock" : "Gateway"} busy, retrying delete (${attempt}/${maxRetries})...`);
            await this.sleep(attempt * 3000);
            continue;
          }

          throw error;
        }
      }

      throw new Error("Failed to delete passcode after 3 retries");
    });
  }

  async updatePasscode(
    lockId: string,
    passcodeId: number,
    passcode: string,
    startDate: Date,
    endDate: Date
  ): Promise<void> {
    const params = {
      lockId,
      keyboardPwdId: passcodeId.toString(),
      keyboardPwd: passcode,
      startDate: startDate.getTime().toString(),
      endDate: endDate.getTime().toString(),
      changeType: "2", // 2 = modify start and end time
    };

    const maxRetries = 3;
    const retryDelay = 2000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.makeRequest<TTLockPasscodeResponse>(
          "/v3/keyboardPwd/change",
          params
        );
        return;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const isGatewayBusy = errorMessage.includes("-2011") || errorMessage.toLowerCase().includes("gateway busy");

        if (isGatewayBusy && attempt < maxRetries) {
          console.log(`[TTLock] Gateway busy, retrying update (${attempt}/${maxRetries})...`);
          await this.sleep(retryDelay);
          continue;
        }

        throw error;
      }
    }

    throw new Error("Failed to update passcode after 3 retries");
  }

  async listPasscodes(
    lockId: string,
    pageNo: number = 1,
    pageSize: number = 100
  ): Promise<Array<{
    id: number;
    code: string;
    name: string;
    type: number;
    startDate: number;
    endDate: number;
  }>> {
    const allResults: Array<{
      id: number;
      code: string;
      name: string;
      type: number;
      startDate: number;
      endDate: number;
    }> = [];

    let currentPage = pageNo;
    const MAX_PAGES = 10; // Safety limit

    while (currentPage <= MAX_PAGES) {
      const response = await this.makeRequest<TTLockListPasscodesResponse>(
        "/v3/lock/listKeyboardPwd",
        {
          lockId,
          pageNo: currentPage.toString(),
          pageSize: pageSize.toString(),
        }
      );

      if (!response.list || response.list.length === 0) {
        break;
      }

      for (const item of response.list) {
        allResults.push({
          id: item.keyboardPwdId,
          code: item.keyboardPwd,
          name: item.keyboardPwdName,
          type: item.keyboardPwdType,
          startDate: item.startDate,
          endDate: item.endDate,
        });
      }

      // If this page had fewer items than pageSize, it's the last page
      if (response.list.length < pageSize) {
        break;
      }

      // If API reports total pages, respect it
      if (response.pages && currentPage >= response.pages) {
        break;
      }

      currentPage++;
    }

    return allResults;
  }

  /**
   * @param strict When true, only a DOCUMENTED no-access answer (10003 /
   * "not lock admin") maps to null — every other failure (timeout, rate
   * limit, 5xx) is rethrown so the caller can tell "no access" apart from
   * "unknown". The default (false) keeps the legacy swallow-everything
   * behavior for callers that only care about battery/name enrichment.
   * The sync cleanup MUST use strict=true: treating a transient error as
   * "no access" is how locks get wrongly deleted.
   */
  async getLockStatus(lockId: string, strict: boolean = false): Promise<{
    battery: number;
    name: string;
    mac: string;
    keyboardPwdVersion?: number;
  } | null> {
    try {
      const response = await this.makeRequest<TTLockLockStatusResponse>(
        "/v3/lock/detail",
        { lockId }
      );

      if (!response.electricQuantity && response.electricQuantity !== 0) {
        // Successful call but incomplete payload. In strict mode this must NOT
        // read as "no access" — the caller would delete the lock over a
        // partial API response. Treat as unknown instead.
        if (strict) {
          throw new Error(`TTLock lock/detail returned no electricQuantity for lock ${lockId} — state unknown`);
        }
        return null;
      }

      return {
        battery: response.electricQuantity,
        name: response.lockAlias || response.lockName,
        mac: response.lockMac,
        keyboardPwdVersion: response.keyboardPwdVersion,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (strict && !msg.includes("10003") && !msg.toLowerCase().includes("not lock admin")) {
        throw error; // transient/unknown — caller must not treat as "no access"
      }
      console.error("Failed to get lock status:", error);
      return null;
    }
  }

  async listLocks(
    pageNo: number = 1,
    pageSize: number = 100
  ): Promise<Array<{
    lockId: number;
    name: string;
    alias: string;
    mac: string;
    battery: number;
    date: number;
  }>> {
    const response = await this.makeRequest<TTLockListLocksResponse>(
      "/v3/lock/list",
      {
        pageNo: pageNo.toString(),
        pageSize: pageSize.toString(),
      }
    );

    if (!response.list || response.list.length === 0) {
      return [];
    }

    return response.list.map(lock => ({
      lockId: lock.lockId,
      name: lock.lockAlias || lock.lockName,
      alias: lock.lockAlias,
      mac: lock.lockMac,
      battery: lock.electricQuantity,
      date: lock.date,
    }));
  }

  async listAllLocks(): Promise<Array<{
    lockId: number;
    name: string;
    alias: string;
    mac: string;
    battery: number;
    date: number;
    groupId?: number;
    groupName?: string;
  }>> {
    const allLocks: Array<{
      lockId: number;
      name: string;
      alias: string;
      mac: string;
      battery: number;
      date: number;
      groupId?: number;
      groupName?: string;
    }> = [];
    
    let currentPage = 1;
    const pageSize = 100;

    while (true) {
      const response = await this.makeRequest<TTLockListLocksResponse>(
        "/v3/lock/list",
        {
          pageNo: currentPage.toString(),
          pageSize: pageSize.toString(),
        }
      );

      if (!response.list || response.list.length === 0) {
        break;
      }

      const locks = response.list.map(lock => ({
        lockId: lock.lockId,
        name: lock.lockAlias || lock.lockName,
        alias: lock.lockAlias,
        mac: lock.lockMac,
        battery: lock.electricQuantity,
        date: lock.date,
        groupId: lock.groupId,
        groupName: lock.groupName,
      }));
      
      allLocks.push(...locks);

      if (response.pages && currentPage >= response.pages) {
        break;
      }

      if (response.total && allLocks.length >= response.total) {
        break;
      }

      currentPage++;
    }

    return allLocks;
  }

  async listGroups(): Promise<Array<{
    groupId: number;
    groupName: string;
  }>> {
    const allGroups: Array<{
      groupId: number;
      groupName: string;
    }> = [];
    const seenGroupIds = new Set<number>();
    
    let currentPage = 1;
    const pageSize = 100;

    while (true) {
      const response = await this.makeRequest<TTLockGroupsResponse>(
        "/v3/group/list",
        {
          pageNo: currentPage.toString(),
          pageSize: pageSize.toString(),
        }
      );

      if (!response.list || response.list.length === 0) {
        break;
      }

      // Filter out groups we've already seen (TTLock API may return same groups on different pages)
      const newGroups = response.list.filter(group => !seenGroupIds.has(group.groupId));
      
      if (newGroups.length === 0) {
        // No new groups found, we've seen all of them
        break;
      }

      for (const group of newGroups) {
        seenGroupIds.add(group.groupId);
        allGroups.push({
          groupId: group.groupId,
          groupName: group.groupName,
        });
      }

      // Stop if we got fewer results than page size (last page)
      if (response.list.length < pageSize) {
        break;
      }

      if (response.pages && currentPage >= response.pages) {
        break;
      }

      if (response.total && allGroups.length >= response.total) {
        break;
      }

      currentPage++;
    }

    return allGroups;
  }

  async getUnlockRecords(
    lockId: string,
    options: {
      startDate?: number;
      endDate?: number;
      pageNo?: number;
      pageSize?: number;
    } = {}
  ): Promise<Array<{
    lockId: number;
    recordType: number;
    success: boolean;
    username: string;
    keyboardPwd?: string;
    lockDate: Date;
    serverDate: Date;
  }>> {
    const { startDate, endDate, pageNo = 1, pageSize = 100 } = options;

    const params: Record<string, string> = {
      lockId,
      pageNo: pageNo.toString(),
      pageSize: pageSize.toString(),
    };

    if (startDate) {
      params.startDate = startDate.toString();
    }
    if (endDate) {
      params.endDate = endDate.toString();
    }

    const response = await this.makeRequest<TTLockUnlockRecordsResponse>(
      "/v3/lockRecord/list",
      params
    );

    if (!response.list) {
      return [];
    }

    return response.list.map(record => ({
      lockId: record.lockId,
      recordType: record.recordType,
      success: record.success === 1,
      username: record.username,
      keyboardPwd: record.keyboardPwd,
      lockDate: new Date(record.lockDate),
      serverDate: new Date(record.serverDate),
    }));
  }

  async getAllUnlockRecordsSince(
    lockId: string,
    sinceDate: Date
  ): Promise<Array<{
    lockId: number;
    recordType: number;
    success: boolean;
    username: string;
    keyboardPwd?: string;
    lockDate: Date;
    serverDate: Date;
  }>> {
    const allRecords: Array<{
      lockId: number;
      recordType: number;
      success: boolean;
      username: string;
      keyboardPwd?: string;
      lockDate: Date;
      serverDate: Date;
    }> = [];

    let currentPage = 1;
    const pageSize = 100;
    const startDate = sinceDate.getTime();

    while (true) {
      const records = await this.getUnlockRecords(lockId, {
        startDate,
        pageNo: currentPage,
        pageSize,
      });

      if (records.length === 0) {
        break;
      }

      allRecords.push(...records);

      if (records.length < pageSize) {
        break;
      }

      currentPage++;
    }

    return allRecords;
  }

  async sendEkey(
    lockId: string,
    receiverUsername: string,
    keyName: string,
    options: {
      startDate: Date;
      endDate: Date;
      remoteEnable?: number;
    }
  ): Promise<{ keyId: number }> {
    const { startDate, endDate, remoteEnable = 1 } = options;

    if (!startDate || !endDate) {
      throw new Error("startDate and endDate are required");
    }

    if (endDate <= startDate) {
      throw new Error("endDate must be after startDate");
    }

    const params = {
      lockId,
      receiverUsername,
      keyName,
      startDate: startDate.getTime().toString(),
      endDate: endDate.getTime().toString(),
      remoteEnable: remoteEnable.toString(),
    };

    const maxRetries = 3;
    const retryDelay = 2000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await this.makeRequest<TTLockEkeyResponse>(
          "/v3/key/send",
          params
        );

        if (!response.keyId) {
          throw new Error("Failed to create eKey: Invalid response from TTLock");
        }

        return {
          keyId: response.keyId,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const isGatewayBusy = errorMessage.includes("-2011") || errorMessage.toLowerCase().includes("gateway busy");

        if (isGatewayBusy && attempt < maxRetries) {
          console.log(`[TTLock] Gateway busy, retrying (${attempt}/${maxRetries})...`);
          await this.sleep(retryDelay);
          continue;
        }

        throw error;
      }
    }

    throw new Error("Failed to create eKey after 3 retries");
  }

  async deleteEkey(keyId: number): Promise<void> {
    await this.makeRequest<TTLockEkeyResponse>("/v3/key/delete", {
      keyId: keyId.toString(),
    });
  }

  async remoteUnlock(lockId: string): Promise<{ success: boolean }> {
    const maxRetries = 3;
    const retryDelay = 2000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.makeRequest<{ errcode: number; errmsg: string }>(
          "/v3/lock/unlock",
          { lockId }
        );
        return { success: true };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const isGatewayBusy = errorMessage.includes("-2011") || errorMessage.toLowerCase().includes("gateway busy");

        if (isGatewayBusy && attempt < maxRetries) {
          console.log(`[TTLock] Gateway busy, retrying unlock (${attempt}/${maxRetries})...`);
          await this.sleep(retryDelay);
          continue;
        }

        throw error;
      }
    }

    throw new Error("Failed to unlock after 3 retries");
  }

  async createQrCode(
    lockId: string,
    name: string,
    startDate: Date,
    endDate: Date
  ): Promise<{ qrCodeId: number }> {
    // TTLock QR code API requires type parameter: 2=permanent, 3=time-limited
    // Using type=3 for time-limited QR codes that match the passcode validity period
    const params = {
      lockId,
      qrCodeName: name,
      type: "3", // Type 3 = time-limited QR code
      startDate: startDate.getTime().toString(),
      endDate: endDate.getTime().toString(),
    };

    const maxRetries = 3;
    const retryDelay = 2000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await this.makeRequest<TTLockQrCodeAddResponse>(
          "/v3/qrCode/add",
          params
        );

        if (!response.qrCodeId) {
          throw new Error("Failed to create QR code: Invalid response from TTLock");
        }

        return {
          qrCodeId: response.qrCodeId,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const isGatewayBusy = errorMessage.includes("-2011") || errorMessage.toLowerCase().includes("gateway busy");

        if (isGatewayBusy && attempt < maxRetries) {
          console.log(`[TTLock] Gateway busy, retrying QR code creation (${attempt}/${maxRetries})...`);
          await this.sleep(retryDelay);
          continue;
        }

        throw error;
      }
    }

    throw new Error("Failed to create QR code after 3 retries");
  }

  async getQrCodeData(lockId: string, qrCodeId: number): Promise<{ qrCodeData: string }> {
    const response = await this.makeRequest<TTLockQrCodeDataResponse>(
      "/v3/qrCode/getData",
      {
        lockId,
        qrCodeId: qrCodeId.toString(),
      }
    );

    // TTLock API returns qrCodeContent field, not qrCodeData
    const qrCodeData = response.qrCodeContent || response.qrCodeData;
    if (!qrCodeData) {
      throw new Error("Failed to get QR code data: Invalid response from TTLock");
    }

    return {
      qrCodeData: qrCodeData.trim(), // Remove trailing newline
    };
  }

  async deleteQrCode(lockId: string, qrCodeId: number): Promise<void> {
    await this.makeRequest<{ errcode: number; errmsg: string }>(
      "/v3/qrCode/delete",
      {
        lockId,
        qrCodeId: qrCodeId.toString(),
      }
    );
  }

  async listQrCodes(
    lockId: string,
    pageNo: number = 1,
    pageSize: number = 100
  ): Promise<Array<{
    qrCodeId: number;
    name: string;
    type: number;
    startDate: number;
    endDate: number;
  }>> {
    const response = await this.makeRequest<TTLockQrCodeListResponse>(
      "/v3/qrCode/list",
      {
        lockId,
        pageNo: pageNo.toString(),
        pageSize: pageSize.toString(),
      }
    );

    if (!response.list) {
      return [];
    }

    return response.list.map(item => ({
      qrCodeId: item.qrCodeId,
      name: item.qrCodeName,
      type: item.qrCodeType,
      startDate: item.startDate,
      endDate: item.endDate,
    }));
  }
}

/**
 * Get or refresh owner access token.
 * Uses in-memory cache with automatic refresh when expired.
 */
export async function getOwnerAccessToken(region: "eu" | "cn" = "eu"): Promise<string> {
  const clientId = process.env.TTLOCK_CLIENT_ID;
  const clientSecret = process.env.TTLOCK_API_KEY;
  const ownerUsername = process.env.TTLOCK_OWNER_USERNAME;
  const ownerPassword = process.env.TTLOCK_OWNER_PASSWORD;

  if (!clientId || !clientSecret) {
    throw new Error("TTLock developer credentials not configured (TTLOCK_CLIENT_ID, TTLOCK_API_KEY)");
  }

  if (!ownerUsername || !ownerPassword) {
    throw new Error("TTLock owner credentials not configured (TTLOCK_OWNER_USERNAME, TTLOCK_OWNER_PASSWORD)");
  }

  // Fast path: cached and valid (with 5 minute buffer)
  const now = Date.now();
  if (ownerTokenCache && ownerTokenCache.expiresAt > now + 5 * 60 * 1000) {
    return ownerTokenCache.accessToken;
  }

  // If another caller is already refreshing, wait for that result instead of issuing a duplicate request
  if (ownerTokenRefreshPromise) {
    return ownerTokenRefreshPromise;
  }

  // We are the first to refresh — other concurrent callers will piggyback on this promise
  ownerTokenRefreshPromise = (async () => {
    try {
      // Double-check after "acquiring lock" — another caller may have finished just before us
      const now2 = Date.now();
      if (ownerTokenCache && ownerTokenCache.expiresAt > now2 + 5 * 60 * 1000) {
        return ownerTokenCache.accessToken;
      }

      console.log("[TTLock Owner] Refreshing owner access token...");

      const tokenResponse = await TTLockClient.getAccessToken(
        clientId,
        clientSecret,
        ownerUsername,
        ownerPassword,
        region
      );

      ownerTokenCache = {
        accessToken: tokenResponse.access_token,
        refreshToken: tokenResponse.refresh_token,
        expiresAt: now2 + tokenResponse.expires_in * 1000,
      };

      console.log("[TTLock Owner] Owner token refreshed successfully");
      return ownerTokenCache.accessToken;
    } finally {
      ownerTokenRefreshPromise = null;
    }
  })();

  return ownerTokenRefreshPromise;
}

/**
 * Create a TTLockClient instance using owner credentials.
 * This sees ALL locks across all hotels.
 */
export async function createOwnerClient(region: "eu" | "cn" = "eu"): Promise<TTLockClient> {
  const clientId = process.env.TTLOCK_CLIENT_ID;
  if (!clientId) {
    throw new Error("TTLock developer credentials not configured (TTLOCK_CLIENT_ID)");
  }

  const accessToken = await getOwnerAccessToken(region);
  return new TTLockClient(clientId, accessToken, region);
}
