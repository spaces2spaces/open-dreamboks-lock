import { type PmsAdapterInterface } from "../pms-adapter-interface";
import { MewsPmsAdapter } from "./mews-pms-adapter";
import { MewsClient } from "../mews-client";
import { type ITenantStorage } from "../storage";

export type PmsType = "mews" | "opera" | "protel" | "cloudbeds" | "other";

export interface PmsAdapterFactoryConfig {
  tenantId: string;
  pmsType: PmsType;
  storage: ITenantStorage;
}

export async function createPmsAdapter(
  config: PmsAdapterFactoryConfig
): Promise<PmsAdapterInterface | null> {
  const { tenantId, pmsType, storage } = config;

  switch (pmsType) {
    case "mews": {
      const [clientToken, accessToken, environment] = await Promise.all([
        storage.getSetting("mews_client_token"),
        storage.getSetting("mews_access_token"),
        storage.getSetting("mews_environment"),
      ]);

      if (!clientToken?.value || !accessToken?.value) {
        console.log(`[PmsAdapterFactory] MEWS credentials not configured for tenant ${tenantId}`);
        return null;
      }

      const mewsClient = new MewsClient(
        clientToken.value,
        accessToken.value,
        (environment?.value as "demo" | "production") || "demo"
      );

      return new MewsPmsAdapter(tenantId, mewsClient);
    }

    case "opera": {
      console.log(`[PmsAdapterFactory] Opera adapter not yet implemented`);
      return null;
    }

    case "protel": {
      console.log(`[PmsAdapterFactory] Protel adapter not yet implemented`);
      return null;
    }

    case "cloudbeds": {
      console.log(`[PmsAdapterFactory] Cloudbeds adapter not yet implemented`);
      return null;
    }

    case "other":
    default: {
      console.log(`[PmsAdapterFactory] Unknown PMS type: ${pmsType}`);
      return null;
    }
  }
}

export async function detectPmsType(storage: ITenantStorage): Promise<PmsType | null> {
  const [mewsToken, operaConfig, protelConfig, cloudbedsConfig] = await Promise.all([
    storage.getSetting("mews_client_token"),
    storage.getSetting("opera_hotel_id"),
    storage.getSetting("protel_hotel_id"),
    storage.getSetting("cloudbeds_property_id"),
  ]);

  if (mewsToken?.value) return "mews";
  if (operaConfig?.value) return "opera";
  if (protelConfig?.value) return "protel";
  if (cloudbedsConfig?.value) return "cloudbeds";

  return null;
}

export async function createPmsAdapterForTenant(
  tenantId: string,
  storage: ITenantStorage
): Promise<PmsAdapterInterface | null> {
  const pmsType = await detectPmsType(storage);
  
  if (!pmsType) {
    console.log(`[PmsAdapterFactory] No PMS configured for tenant ${tenantId}`);
    return null;
  }

  return createPmsAdapter({ tenantId, pmsType, storage });
}
