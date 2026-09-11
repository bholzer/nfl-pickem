import { createServer } from "node:http";
import { expect, it } from "vitest";

it("blocks unhandled asset URLs before they reach even a local transport", async () => {
  let received = 0;
  const server = createServer((_request, response) => {
    received += 1;
    response.end("unexpected passthrough");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected the safety server to bind a loopback port");
    }
    const { port } = address;
    await expect(
      fetch(`http://127.0.0.1:${port}/private.json`),
    ).rejects.toBeInstanceOf(Error);
    expect(received).toBe(0);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }
});
