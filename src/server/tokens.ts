import type { SeasonWeek, User } from "../shared/contracts";
import { validSeason, validWeek } from "../shared/season";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export class TokenConfigurationError extends Error {}

function keyBytes(secret: string) {
  if (typeof secret !== "string") {
    throw new TokenConfigurationError("A signing secret is required");
  }
  const bytes = encoder.encode(secret);
  if (bytes.byteLength < 32) {
    throw new TokenConfigurationError(
      "A signing secret of at least 32 bytes is required",
    );
  }
  return bytes;
}

export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decode(segment: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) {
    throw new Error("Invalid encoding");
  }
  const bytes = Uint8Array.from(
    atob(segment.replaceAll("-", "+").replaceAll("_", "/")),
    (char) => char.charCodeAt(0),
  );
  if (base64url(bytes) !== segment) {
    throw new Error("Noncanonical encoding");
  }
  return bytes;
}

export async function signToken(
  payload: Record<string, unknown>,
  secret: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const message = `${base64url(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })))}.${base64url(encoder.encode(JSON.stringify(payload)))}`;
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(message),
  );
  return `${message}.${base64url(new Uint8Array(signature))}`;
}

function validHeader(segment: string): boolean {
  const header = JSON.parse(decoder.decode(decode(segment))) as {
    alg?: unknown;
    typ?: unknown;
    crit?: unknown;
  } | null;
  return (
    !!header &&
    typeof header === "object" &&
    !Array.isArray(header) &&
    header.alg === "HS256" &&
    (header.typ === undefined || header.typ === "JWT") &&
    header.crit === undefined
  );
}

function isSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value);
}

function tokenPayload(segment: string): Record<string, unknown> | null {
  const payload = JSON.parse(decoder.decode(decode(segment))) as Record<
    string,
    unknown
  > | null;
  const now = Math.floor(Date.now() / 1000);
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    !isSafeInteger(payload.exp) ||
    payload.exp <= now
  ) {
    return null;
  }
  if (
    payload.nbf !== undefined &&
    (!isSafeInteger(payload.nbf) || payload.nbf > now)
  ) {
    return null;
  }
  return payload;
}

export async function verifyToken(
  token: string,
  secret: string,
): Promise<Record<string, unknown> | null> {
  const bytes = keyBytes(secret);
  try {
    if (token.length > 8192) {
      return null;
    }
    const parts = token.split(".");
    if (parts.length !== 3) {
      return null;
    }
    const [headerPart, payloadPart, signaturePart] = parts;
    if (
      headerPart === undefined ||
      payloadPart === undefined ||
      signaturePart === undefined
    ) {
      return null;
    }
    if (!validHeader(headerPart)) {
      return null;
    }
    const signature = decode(signaturePart);
    if (signature.length !== 32) {
      return null;
    }
    const key = await crypto.subtle.importKey(
      "raw",
      bytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    if (
      !(await crypto.subtle.verify(
        "HMAC",
        key,
        signature,
        encoder.encode(`${headerPart}.${payloadPart}`),
      ))
    ) {
      return null;
    }
    return tokenPayload(payloadPart);
  } catch {
    return null;
  }
}

export async function generateSubmissionToken(
  user: User,
  { season, week }: SeasonWeek,
  secret: string,
): Promise<string> {
  if (
    !user.discordId ||
    !user.username ||
    !validSeason(season) ||
    !validWeek(week)
  ) {
    throw new Error("Invalid submission token identity or season/week");
  }
  return signToken(
    {
      user_id: user.discordId,
      username: user.username,
      season,
      week,
      exp: Math.floor(Date.now() / 1000) + 365 * 86400,
    },
    secret,
  );
}
