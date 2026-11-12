import type { PaymentDirection } from "../../shared/contracts";

/**
 * One completed Venmo payment between the banker and someone else, however it
 * reached us (statement CSV or, later, a notification email).
 */
export interface VenmoPayment {
  transactionId: string;
  direction: PaymentDirection;
  /** Whole cents, always positive. */
  amountCents: number;
  /** The other party's Venmo display name, as Venmo reported it. */
  counterparty: string;
  note: string | null;
  /** Normalized `toISOString()` value. */
  paidAt: string;
}

export interface VenmoClassification {
  status: "approved" | "pending";
  /** The player whose display name matched, if any. */
  userId: number | null;
}

/** Trimmed, single-spaced, lowercase; the form display names are matched in. */
export function normalizeVenmoName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Approves a payment only when its counterparty is a known player AND its note
 * mentions a pool keyword: the banker also swaps unrelated Venmo payments with
 * players, so a known name alone is not enough. Everything else waits for
 * review, with the player filled in when the name is known.
 */
export function classifyVenmoPayment(
  payment: Pick<VenmoPayment, "counterparty" | "note">,
  owners: ReadonlyMap<string, number>,
  keywords: readonly string[],
): VenmoClassification {
  const userId = owners.get(normalizeVenmoName(payment.counterparty)) ?? null;
  const note = (payment.note ?? "").toLowerCase();
  const mentionsPool = keywords.some(
    (keyword) => keyword !== "" && note.includes(keyword.toLowerCase()),
  );
  return {
    status: userId !== null && mentionsPool ? "approved" : "pending",
    userId,
  };
}
