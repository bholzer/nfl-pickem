import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc", environment: "local" },
      remoteBindings: false,
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(
            fileURLToPath(new URL("./migrations", import.meta.url)),
          ),
          SESSION_SECRET:
            "test-only-session-secret-012345678901234567890123456789",
          SUBMISSION_TOKEN_SECRET:
            "test-only-submission-secret-012345678901234567890123456789",
          DISCORD_CLIENT_SECRET: "test-only-discord-client-secret",
          DISCORD_BOT_TOKEN: "test-only-discord-bot-token",
          DISCORD_CLIENT_ID: "synthetic-client",
          DISCORD_CHANNEL_ID: "9999",
          DISCORD_ALLOWED_CHANNEL_IDS: "9999",
          DISCORD_ALLOWED_USER_IDS: "1001,1002",
          DISCORD_SEND_ENABLED: "true",
          SCHEDULES_ENABLED: "true",
        },
        // Runtime-level deny applies even if a test restores the original fetch.
        outboundService(request) {
          throw new Error(
            `Unmocked outbound request blocked: ${request.method} ${request.url}`,
          );
        },
      },
    })),
  ],
  test: {
    name: "workers",
    include: ["tests/workers/**/*.test.ts"],
    setupFiles: ["./tests/setup-workers.ts"],
    isolate: true,
    restoreMocks: true,
  },
});
