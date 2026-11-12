import type { ForwardableEmailMessage } from "@cloudflare/workers-types";
import PostalMime, { type Email } from "postal-mime";
import type { Env } from "./env";
import { matchesForwarder, parseVenmoEmail } from "./services/venmo-email";
import { recordVenmoPayments } from "./services/venmo-import";
import { recordVenmoEmailFailure } from "./venmo-email-failures";

/** Venmo notifications are a few tens of kilobytes. */
const MAX_EMAIL_BYTES = 1024 * 1024;
const VENMO_SENDER = "venmo@venmo.com";

type RejectReason =
  | "not_configured"
  | "recipient_mismatch"
  | "forwarder_mismatch"
  | "too_large"
  | "unparseable";

function rejection(
  message: ForwardableEmailMessage,
  env: Pick<Env, "VENMO_INBOX_ADDRESS" | "VENMO_FORWARDER_ADDRESS">,
): RejectReason | null {
  const inbox = env.VENMO_INBOX_ADDRESS?.trim() ?? "";
  const forwarder = env.VENMO_FORWARDER_ADDRESS?.trim() ?? "";
  if (inbox === "" || forwarder === "") {
    return "not_configured";
  }
  if (message.to.trim().toLowerCase() !== inbox.toLowerCase()) {
    return "recipient_mismatch";
  }
  if (!matchesForwarder(message.from, forwarder)) {
    return "forwarder_mismatch";
  }
  return message.rawSize > MAX_EMAIL_BYTES ? "too_large" : null;
}

function reject(message: ForwardableEmailMessage, reason: RejectReason): void {
  // Never log addresses, subjects, or payment details; the code is enough to
  // diagnose Email Routing or forwarding setup with `wrangler tail`.
  console.warn("Venmo email rejected", { reason });
  message.setReject("Message not accepted");
}

async function parseMessage(message: ForwardableEmailMessage) {
  try {
    return await PostalMime.parse(
      await new Response(message.raw).arrayBuffer(),
    );
  } catch {
    return null;
  }
}

/** Reads a message that passed the envelope checks and records its payment. */
async function ingest(
  email: Email,
  db: Env["DB"],
  receivedAt: string,
): Promise<void> {
  if (email.from?.address?.trim().toLowerCase() !== VENMO_SENDER) {
    console.info("Venmo email ignored", { reason: "not_venmo" });
    return;
  }
  const subject = email.subject ?? "";
  const result = parseVenmoEmail({
    subject,
    html: email.html ?? "",
    text: email.text ?? "",
    date: email.date ?? null,
    receivedAt,
  });
  if (result.ok) {
    const recorded = await recordVenmoPayments(
      db,
      [result.payment],
      "venmo_email",
    );
    console.info("Venmo email recorded", recorded);
  } else if (result.paymentLike) {
    await recordVenmoEmailFailure(db, {
      receivedAt,
      subject,
      reason: result.reason,
    });
    console.warn("Venmo email unreadable");
  } else {
    console.info("Venmo email ignored", { reason: "not_payment" });
  }
}

/**
 * Records Venmo payment notifications that the banker's mailbox forwards to
 * the secret inbox address. Payments go through the same classification and
 * transaction-ID deduplication as statement imports. Throwing makes delivery
 * fail temporarily so the sender retries; that is safe because a re-delivered
 * payment is a duplicate by transaction ID.
 */
export async function handleEmail(
  message: ForwardableEmailMessage,
  env: Env,
): Promise<void> {
  const rejected = rejection(message, env);
  if (rejected) {
    reject(message, rejected);
    return;
  }
  if (env.MAINTENANCE_MODE === "true") {
    throw new Error("Writes are paused for maintenance");
  }
  const receivedAt = new Date().toISOString();
  const email = await parseMessage(message);
  if (email) {
    await ingest(email, env.DB, receivedAt);
  } else {
    reject(message, "unparseable");
  }
}
