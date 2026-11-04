import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Integration tests run against a real PostgreSQL database that is reset
 * before the run. Point TEST_DATABASE_URL at a throw-away database.
 */
const url = process.env.TEST_DATABASE_URL ?? "postgresql://qms:qms@localhost:5432/qms_test?schema=public";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    globalSetup: ["tests/integration/global-setup.ts"],
    env: { DATABASE_URL: url, SMTP_HOST: "" },
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
