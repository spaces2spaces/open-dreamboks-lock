import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["server/__tests__/**/*.test.ts"],
    testTimeout: 10000,
    env: {
      // Dummy value so db.ts doesn't throw on import — no actual DB connection is made in tests
      DATABASE_URL: process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test",
      // Deployment identity for server/config.ts — tests assert on these, never on a real domain.
      APP_BASE_URL: "https://lock.example.com",
      DEFAULT_HOTEL_NAME: "Example Hotel",
      GUEST_EMAIL_FALLBACK_DOMAIN: "guest.example.com",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./client/src"),
      "@shared": path.resolve(__dirname, "./shared"),
    },
  },
});
