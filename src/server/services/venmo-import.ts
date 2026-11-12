import type { D1Database } from "@cloudflare/workers-types";
import type { VenmoImportResult } from "../../shared/contracts";
import { seasonForDate } from "../../shared/season";
import { insertImportedPayments } from "../ledger";
import { listPaymentKeywords, venmoNameOwners } from "../venmo-accounts";
import { classifyVenmoPayment, type VenmoPayment } from "./venmo";

/**
 * Classifies and records Venmo payments from any source. A payment whose
 * transaction ID is already in the ledger, in any status, is a duplicate and
 * changes nothing. Each payment's season is the season its date falls in.
 */
export async function recordVenmoPayments(
  db: D1Database,
  payments: readonly VenmoPayment[],
  source: "venmo_csv" | "venmo_email",
): Promise<Omit<VenmoImportResult, "skipped">> {
  const [owners, keywords] = await Promise.all([
    venmoNameOwners(db),
    listPaymentKeywords(db),
  ]);
  const entries = payments.map((payment) => ({
    ...classifyVenmoPayment(payment, owners, keywords),
    season: seasonForDate(new Date(payment.paidAt)),
    source,
    direction: payment.direction,
    amountCents: payment.amountCents,
    venmoTransactionId: payment.transactionId,
    venmoName: payment.counterparty,
    note: payment.note,
    paidAt: payment.paidAt,
  }));
  const inserted = await insertImportedPayments(db, entries);
  const result = { approved: 0, pending: 0, duplicates: 0 };
  entries.forEach((entry, index) => {
    if (inserted[index]) {
      result[entry.status] += 1;
    } else {
      result.duplicates += 1;
    }
  });
  return result;
}
