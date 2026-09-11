import type { Env } from "../env";

export function isTrustedWebOrigin(
  url: URL,
  environment: Env["APP_ENV"],
): boolean {
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    return false;
  }
  if (url.protocol === "https:") {
    return true;
  }
  return (
    environment === "local" &&
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  );
}
