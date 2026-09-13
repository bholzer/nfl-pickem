import { env } from "cloudflare:workers";
import { assert, expect, it, vi } from "vitest";
import { sendChannelMessage } from "../../src/server/services/discord";

it("can send an approved message using a valid Workers request without following redirects", async () => {
  const seen: Request[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const request = new Request(input, init);
    seen.push(request);
    return Promise.resolve(Response.json({ id: "7777", channel_id: "9999" }));
  });
  await sendChannelMessage(env, "9999", "Local runtime verification");
  expect(seen).toHaveLength(1);
  const request = seen[0];
  assert(request);
  expect(request.redirect).toBe("manual");
  expect(await request.json()).toMatchObject({
    content: "Local runtime verification",
    allowed_mentions: { parse: [] },
  });
});
