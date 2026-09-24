import express from "express";
import { MewsClient } from "./mews-client";
import { IngestionClient } from "./ingestion-client";
import { MewsPoller } from "./poller";
import { config, validateConfig, updateConfig } from "./config";

const app = express();
app.use(express.json());

let poller: MewsPoller | null = null;
let lastPollTime: Date | null = null;
let lastPollStatus: "success" | "error" | "pending" = "pending";
let lastPollMessage: string = "Not started";
let pollCount = 0;
let errorCount = 0;

async function fetchConfigFromCore(): Promise<boolean> {
  try {
    console.log(`Fetching config from ${config.core.baseUrl}/api/settings...`);
    const response = await fetch(`${config.core.baseUrl}/api/settings`);
    if (!response.ok) {
      console.log(`Failed to fetch settings: ${response.status}`);
      return false;
    }
    
    const settings = await response.json() as Array<{ key: string; value: string }>;
    console.log(`Received ${settings.length} settings from Core`);
    console.log(`Settings keys: ${settings.map(s => s.key).join(", ")}`);
    
    const settingsMap = new Map(settings.map((s: { key: string; value: string }) => [s.key, s.value]));
    
    const clientToken = settingsMap.get("mews_client_token");
    const accessToken = settingsMap.get("mews_access_token");
    const environment = settingsMap.get("mews_environment") as "demo" | "production" | undefined;
    
    console.log(`MEWS config found: clientToken=${!!clientToken}, accessToken=${!!accessToken}`);
    
    if (clientToken && accessToken) {
      updateConfig({
        mewsClientToken: clientToken,
        mewsAccessToken: accessToken,
        mewsEnvironment: environment || "demo",
      });
      console.log("MEWS config updated successfully");
      return true;
    }
    return false;
  } catch (error) {
    console.log("Could not fetch config from Core:", error instanceof Error ? error.message : "unknown");
    return false;
  }
}

async function startPoller() {
  await fetchConfigFromCore();
  
  const configErrors = validateConfig();
  if (configErrors.length > 0) {
    console.log("Configuration incomplete, poller not started:");
    configErrors.forEach((err: string) => console.log(`  - ${err}`));
    lastPollStatus = "error";
    lastPollMessage = `Missing config: ${configErrors.join(", ")}`;
    return;
  }

  const mewsClient = new MewsClient(
    config.mews.clientToken!,
    config.mews.accessToken!,
    config.mews.environment
  );

  const ingestionClient = new IngestionClient(
    config.core.baseUrl,
    config.core.tenantId!,
    config.core.webhookSecret!
  );

  poller = new MewsPoller(mewsClient, ingestionClient, config.mews.pollIntervalMs);
  
  poller.onPollComplete((result: { success: boolean; eventsCount: number; error?: string }) => {
    lastPollTime = new Date();
    pollCount++;
    if (result.success) {
      lastPollStatus = "success";
      lastPollMessage = `Processed ${result.eventsCount} events`;
    } else {
      lastPollStatus = "error";
      lastPollMessage = result.error || "Unknown error";
      errorCount++;
    }
  });

  await poller.start();
  console.log("MEWS Poller started");
}

app.get("/", (_req, res) => {
  res.json({
    name: "MEWS Adapter",
    version: "1.0.0",
    status: poller ? "running" : "stopped",
    config: {
      mewsEnvironment: config.mews.environment,
      coreBaseUrl: config.core.baseUrl,
      hasMewsCredentials: !!(config.mews.clientToken && config.mews.accessToken),
      hasCoreCredentials: !!(config.core.tenantId && config.core.webhookSecret),
    },
  });
});

app.get("/status", (_req, res) => {
  res.json({
    poller: {
      running: !!poller,
      lastPollTime: lastPollTime?.toISOString() || null,
      lastPollStatus,
      lastPollMessage,
      pollCount,
      errorCount,
    },
    config: {
      mewsEnvironment: config.mews.environment,
      pollIntervalMs: config.mews.pollIntervalMs,
      coreBaseUrl: config.core.baseUrl,
    },
  });
});

app.post("/poll-now", async (_req, res) => {
  if (!poller) {
    return res.status(400).json({ error: "Poller not running" });
  }
  
  try {
    await poller.pollNow();
    res.json({ success: true, message: "Poll triggered" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

app.post("/start", async (_req, res) => {
  if (poller) {
    return res.status(400).json({ error: "Poller already running" });
  }
  
  await startPoller();
  res.json({ success: true, message: "Poller started" });
});

app.post("/stop", (_req, res) => {
  if (!poller) {
    return res.status(400).json({ error: "Poller not running" });
  }
  
  poller.stop();
  poller = null;
  res.json({ success: true, message: "Poller stopped" });
});

const PORT = process.env.MEWS_ADAPTER_PORT || 3001;

app.listen(Number(PORT), "0.0.0.0", () => {
  console.log(`MEWS Adapter running on port ${PORT}`);
  startPoller();
});
