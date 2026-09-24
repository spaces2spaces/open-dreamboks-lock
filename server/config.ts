export type Environment = "development" | "staging" | "production";

export interface EnvironmentConfig {
  environment: Environment;
  isDevelopment: boolean;
  isStaging: boolean;
  isProduction: boolean;
  databaseUrl: string;
  logLevel: "debug" | "info" | "warn" | "error";
}

function getEnvironment(): Environment {
  const env = process.env.NODE_ENV || "development";
  if (env === "production") return "production";
  if (env === "staging") return "staging";
  return "development";
}

export function getConfig(): EnvironmentConfig {
  const environment = getEnvironment();
  
  return {
    environment,
    isDevelopment: environment === "development",
    isStaging: environment === "staging",
    isProduction: environment === "production",
    databaseUrl: process.env.DATABASE_URL || "",
    logLevel: environment === "production" ? "info" : "debug",
  };
}

export const config = getConfig();
