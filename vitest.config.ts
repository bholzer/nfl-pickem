import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "./vitest.workers.config.ts",
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/unit/**/*.test.ts"],
          setupFiles: ["./tests/setup-network.ts"],
          restoreMocks: true,
        },
      },
      {
        test: {
          name: "client",
          environment: "jsdom",
          environmentOptions: { jsdom: { url: "http://localhost/" } },
          include: ["tests/client/**/*.test.{ts,tsx}"],
          setupFiles: ["./tests/setup-client.ts"],
          restoreMocks: true,
        },
      },
    ],
  },
});
