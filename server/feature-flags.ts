import type { ITenantStorage } from "./storage";

export type FeatureFlag = 
  | "online_checkin"
  | "pms_mews"
  | "pms_opera"
  | "pms_protel"
  | "pms_cloudbeds"
  | "sms_notifications"
  | "email_notifications"
  | "google_wallet"
  | "apple_wallet";

const FEATURE_FLAG_PREFIX = "feature_";

const DEFAULT_FLAGS: Record<FeatureFlag, boolean> = {
  online_checkin: true,
  pms_mews: true,
  pms_opera: false,
  pms_protel: false,
  pms_cloudbeds: false,
  sms_notifications: true,
  email_notifications: true,
  google_wallet: false,
  apple_wallet: false,
};

export class FeatureFlagService {
  constructor(private storage: ITenantStorage) {}

  async isEnabled(flag: FeatureFlag): Promise<boolean> {
    const settingKey = `${FEATURE_FLAG_PREFIX}${flag}`;
    const setting = await this.storage.getSetting(settingKey);
    
    if (!setting) {
      return DEFAULT_FLAGS[flag] ?? false;
    }
    
    return setting.value === "true" || setting.value === "1";
  }

  async setEnabled(flag: FeatureFlag, enabled: boolean): Promise<void> {
    const settingKey = `${FEATURE_FLAG_PREFIX}${flag}`;
    await this.storage.setSetting(settingKey, enabled ? "true" : "false");
  }

  async getAllFlags(): Promise<Record<FeatureFlag, boolean>> {
    const flags: Partial<Record<FeatureFlag, boolean>> = {};
    
    for (const flag of Object.keys(DEFAULT_FLAGS) as FeatureFlag[]) {
      flags[flag] = await this.isEnabled(flag);
    }
    
    return flags as Record<FeatureFlag, boolean>;
  }

  async requireFeature(flag: FeatureFlag, errorMessage?: string): Promise<void> {
    const enabled = await this.isEnabled(flag);
    if (!enabled) {
      throw new Error(errorMessage || `Feature '${flag}' is not enabled for this tenant`);
    }
  }
}

export function createFeatureFlagService(storage: ITenantStorage): FeatureFlagService {
  return new FeatureFlagService(storage);
}
