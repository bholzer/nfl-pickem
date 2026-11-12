import { HTTPException } from "hono/http-exception";

/** Field name -> message, returned with a 422. */
export type Fields = Record<string, string>;
export type Validated<T> =
  { valid: true; value: T } | { valid: false; fields: Fields };

export function validUserId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function objectBody(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

/** A positive integer path parameter, or 400 with `message`. */
export function parseId(raw: string, message: string): number {
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new HTTPException(400, { message });
  }
  return Number(raw);
}

/** Field messages for the failed checks; empty when every check passed. */
export function failedFields(
  checks: readonly [string, boolean, string][],
): Fields {
  return Object.fromEntries(
    checks
      .filter(([, ok]) => !ok)
      .map(([field, , message]) => [field, message]),
  );
}
