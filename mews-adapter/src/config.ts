export interface Config {
  mews: {
    clientToken: string | null;
    accessToken: string | null;
    environment: "demo" | "production";
    pollIntervalMs: number;
  };
  core: {
    baseUrl: string;
    tenantId: string | null;
    webhookSecret: string | null;
  };
}

export const config: Config = {
  mews: {
    clientToken: process.env.MEWS_CLIENT_TOKEN || null,
    accessToken: process.env.MEWS_ACCESS_TOKEN || null,
    environment: (process.env.MEWS_ENVIRONMENT as "demo" | "production") || "demo",
    pollIntervalMs: parseInt(process.env.MEWS_POLL_INTERVAL_MS || "60000", 10),
  },
  core: {
    baseUrl: process.env.DREAMBOKS_CORE_URL || "http://0.0.0.0:5000",
    tenantId: process.env.DREAMBOKS_TENANT_ID || null,
    webhookSecret: process.env.DREAMBOKS_WEBHOOK_SECRET || null,
  },
};

export function updateConfig(updates: Partial<{ 
  mewsClientToken: string; 
  mewsAccessToken: string; 
  mewsEnvironment: "demo" | "production";
}>) {
  if (updates.mewsClientToken) config.mews.clientToken = updates.mewsClientToken;
  if (updates.mewsAccessToken) config.mews.accessToken = updates.mewsAccessToken;
  if (updates.mewsEnvironment) config.mews.environment = updates.mewsEnvironment;
}

export function validateConfig(): string[] {
  const errors: string[] = [];
  
  if (!config.mews.clientToken) {
    errors.push("MEWS_CLIENT_TOKEN");
  }
  if (!config.mews.accessToken) {
    errors.push("MEWS_ACCESS_TOKEN");
  }
  if (!config.core.tenantId) {
    errors.push("DREAMBOKS_TENANT_ID");
  }
  if (!config.core.webhookSecret) {
    errors.push("DREAMBOKS_WEBHOOK_SECRET");
  }
  
  return errors;
}
