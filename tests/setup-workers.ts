import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import { beforeEach, vi } from "vitest";

// No outbound network during module evaluation, hooks, or tests. Individual tests
// can intercept fetch with vi.spyOn(globalThis, "fetch").mockImplementation(...).
// Miniflare's outboundService remains a second deny layer underneath this mock.
function denyOutbound(): never {
  throw new Error("Unmocked outbound fetch blocked in Workers tests");
}
vi.stubGlobal("fetch", denyOutbound);

beforeEach(async () => {
  vi.stubGlobal("fetch", denyOutbound);
  // The current plugin isolates files; reset adds isolation between test cases.
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
