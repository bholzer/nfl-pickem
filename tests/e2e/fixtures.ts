import { test as base, expect } from "@playwright/test";
import {
  startRehearsal,
  type Rehearsal,
} from "../../scripts/rehearsal/runtime.mjs";

export const test = base.extend<
  { networkGuard: undefined },
  { rehearsal: Rehearsal }
>({
  rehearsal: [
    async ({}, provide) => {
      const rehearsal = await startRehearsal();
      try {
        await provide(rehearsal);
      } finally {
        await rehearsal.close();
      }
    },
    { scope: "worker" },
  ],
  networkGuard: [
    async ({ context, rehearsal }, provide) => {
      const blocked: string[] = [];
      const pageErrors: string[] = [];
      // Intercept transport, not the application's API. Every same-origin request
      // continues into the real compiled Worker + native static-assets router.
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin === rehearsal.origin) {
          return route.continue();
        }
        blocked.push(
          `${route.request().method()} ${url.origin}${url.pathname}`,
        );
        await route.abort("blockedbyclient");
      });
      await context.routeWebSocket("**/*", async (socket) => {
        blocked.push(`WebSocket ${new URL(socket.url()).origin}`);
        await socket.close();
      });
      context.on("page", (page) =>
        page.on("pageerror", (error) => pageErrors.push(error.message)),
      );
      try {
        await provide(undefined);
      } finally {
        expect(blocked, "Browser attempted non-local transport").toEqual([]);
        expect(
          rehearsal.upstreams.forbidden,
          "Worker attempted non-fixture transport",
        ).toEqual([]);
        expect(
          rehearsal.upstreams.requests.filter((request) =>
            request.includes("discord.com"),
          ),
          "Sends-disabled jobs must never call Discord",
        ).toEqual([]);
        expect(pageErrors, "Built browser application threw").toEqual([]);
      }
    },
    { auto: true },
  ],
});

export { expect };
