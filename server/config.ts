export type Environment = "development" | "staging" | "production";

export interface EnvironmentConfig {
  environment: Environment;
  isDevelopment: boolean;
  isStaging: boolean;
  isProduction: boolean;
  databaseUrl: string;
  logLevel: "debug" | "info" | "warn" | "error";
  /** Public base URL of this deployment — used for guest links when a tenant has no `app_base_url` setting. */
  appBaseUrl: string;
  /** Hotel name used in guest messages when a tenant has no `hotel_name` setting. */
  defaultHotelName: string;
  /** Domain for placeholder guest e-mail addresses handed to the PMS when a guest has none. Must be a domain you control. */
  guestEmailFallbackDomain: string;
}

function getEnvironment(): Environment {
  const env = process.env.NODE_ENV || "development";
  if (env === "production") return "production";
  if (env === "staging") return "staging";
  return "development";
}

export function getConfig(): EnvironmentConfig {
  const environment = getEnvironment();
  const appBaseUrl = (process.env.APP_BASE_URL || "http://localhost:5000").replace(/\/+$/, "");
  let appHost = "localhost";
  try { appHost = new URL(appBaseUrl).hostname; } catch { /* keep default */ }

  return {
    environment,
    isDevelopment: environment === "development",
    isStaging: environment === "staging",
    isProduction: environment === "production",
    databaseUrl: process.env.DATABASE_URL || "",
    logLevel: environment === "production" ? "info" : "debug",
    appBaseUrl,
    defaultHotelName: process.env.DEFAULT_HOTEL_NAME || "the hotel",
    guestEmailFallbackDomain: process.env.GUEST_EMAIL_FALLBACK_DOMAIN || appHost,
  };
}

export const config = getConfig();
