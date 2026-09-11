import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach } from "vitest";

// Tests opt in to individual mocked responses with network.use(...handlers).
// No real fetch, Node HTTP(S), or jsdom XMLHttpRequest may leave this process.
export const network = setupServer(http.all("*", () => HttpResponse.error()));
network.listen({
  onUnhandledRequest() {
    // Reject anything outside the catch-all HTTP handler as well. MSW's built-in
    // strategy allows assets through, and print.error() alone does not abort.
    throw new Error("Unmocked outbound request blocked in tests");
  },
});

afterEach(() => {
  network.resetHandlers();
});
afterAll(() => {
  network.close();
});
