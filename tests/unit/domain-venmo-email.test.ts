import { readFileSync } from "node:fs";
import PostalMime from "postal-mime";
import { describe, expect, it } from "vitest";
import {
  decodeHtmlEntities,
  matchesForwarder,
  parseVenmoEmail,
  type VenmoEmail,
} from "../../src/server/services/venmo-email";

const receivedAt = "2026-11-12T02:22:20.000Z";

async function fixture(name: string): Promise<VenmoEmail> {
  const email = await PostalMime.parse(
    readFileSync(new URL(`../fixtures/${name}`, import.meta.url)),
  );
  return {
    subject: email.subject ?? "",
    html: email.html ?? "",
    text: email.text ?? "",
    date: email.date ?? null,
    receivedAt,
  };
}

const incoming = await fixture("venmo-email-incoming.eml");
const outgoing = await fixture("venmo-email-outgoing.eml");
const incomingSubject =
  "Casey Rivera paid $5.00 to your Venmo account. Leave it in Venmo or transfer it to your bank account.";

/** Replaces the inner HTML of the note paragraph. */
function withNote(email: VenmoEmail, note: string): VenmoEmail {
  return {
    ...email,
    html: email.html.replace(
      /(class="transaction-note[^"]*"[^>]*>)[^<]*(<\/p>)/,
      `$1${note}$2`,
    ),
  };
}

describe("Venmo email parsing", () => {
  it("reads an incoming payment, taking the name's casing from the subject", () => {
    expect(incoming.subject).toBe(incomingSubject);
    expect(parseVenmoEmail(incoming)).toEqual({
      ok: true,
      payment: {
        transactionId: "1AB23456CD789012E",
        direction: "in",
        amountCents: 500,
        counterparty: "Casey Rivera",
        note: "Mo games",
        paidAt: "2026-11-12T02:22:16.000Z",
      },
    });
  });

  it("reads an outgoing payment", () => {
    expect(parseVenmoEmail(outgoing)).toEqual({
      ok: true,
      payment: {
        transactionId: "9ZY87654XW321098V",
        direction: "out",
        amountCents: 2000,
        counterparty: "Casey Rivera",
        note: "More games",
        paidAt: "2026-11-12T01:55:24.000Z",
      },
    });
  });

  it("accepts the body heading phrasing as a subject and thousands separators", () => {
    const html = outgoing.html.replaceAll("$20.00", "$1,250.50");
    const result = parseVenmoEmail({
      ...outgoing,
      subject: "You paid Casey Rivera $1,250.50",
      html,
    });
    expect(result).toMatchObject({
      ok: true,
      payment: { amountCents: 125050 },
    });
    const paidYou = parseVenmoEmail({
      ...incoming,
      subject: "Jordan  Blake paid you $5",
    });
    expect(paidYou).toMatchObject({
      ok: true,
      payment: {
        direction: "in",
        counterparty: "Jordan Blake",
        amountCents: 500,
      },
    });
  });

  it("decodes entity-encoded and emoji notes, and treats a blank note as none", () => {
    const encoded = parseVenmoEmail(
      withNote(incoming, " Wings &amp; picks &#39;26 &#x1F3C8;\n &lt;3 "),
    );
    expect(encoded).toMatchObject({
      payment: { note: "Wings & picks '26 \u{1F3C8} <3" },
    });
    const emoji = parseVenmoEmail(withNote(incoming, "🏈💸 games"));
    expect(emoji).toMatchObject({ payment: { note: "🏈💸 games" } });
    expect(parseVenmoEmail(withNote(incoming, "  "))).toMatchObject({
      payment: { note: null },
    });
    const noNote = {
      ...incoming,
      html: incoming.html.replace(
        /<p class="transaction-note[\s\S]*?<\/p>/,
        "",
      ),
    };
    expect(parseVenmoEmail(noNote)).toMatchObject({
      ok: true,
      payment: { note: null },
    });
  });

  it("falls back to the receive time when the Date header is unusable", () => {
    expect(parseVenmoEmail({ ...incoming, date: "not a date" })).toMatchObject({
      payment: { paidAt: receivedAt },
    });
    expect(parseVenmoEmail({ ...incoming, date: null })).toMatchObject({
      payment: { paidAt: receivedAt },
    });
  });

  it("fails a payment notice without a transaction ID", () => {
    const html = incoming.html.replace("1AB23456CD789012E", "");
    expect(parseVenmoEmail({ ...incoming, html })).toEqual({
      ok: false,
      paymentLike: true,
      reason: "The email has no Venmo transaction ID",
    });
    const unlabeled = incoming.html.replace("Transaction ID", "Reference");
    expect(parseVenmoEmail({ ...incoming, html: unlabeled })).toMatchObject({
      ok: false,
      paymentLike: true,
    });
  });

  it("fails rather than guessing when the body disagrees with the subject", () => {
    const amount = parseVenmoEmail({
      ...incoming,
      subject: incomingSubject.replace("$5.00", "$50.00"),
    });
    expect(amount).toEqual({
      ok: false,
      paymentLike: true,
      reason: "The email body does not match the subject's payment",
    });
    const direction = parseVenmoEmail({
      ...incoming,
      subject: "You paid Casey Rivera $5.00",
    });
    expect(direction).toMatchObject({ ok: false, paymentLike: true });
  });

  it("marks unreadable payment subjects as payment-like and drops everything else", () => {
    expect(
      parseVenmoEmail({
        ...incoming,
        subject: "Casey Rivera paid your request",
      }),
    ).toMatchObject({ ok: false, paymentLike: true });
    expect(
      parseVenmoEmail({ ...incoming, subject: "You paid Casey Rivera $5.001" }),
    ).toMatchObject({ ok: false, paymentLike: true });
    for (const subject of [
      "Casey Rivera requests $5.00",
      "Your transfer of $50.00 is on its way",
      "Unpaid balance reminder",
      "Introducing Venmo stickers",
    ]) {
      expect(parseVenmoEmail({ ...incoming, subject })).toEqual({
        ok: false,
        paymentLike: false,
        reason: "Not a payment notification",
      });
    }
  });
});

describe("HTML entity decoding", () => {
  it("decodes basic named and numeric references and keeps unknown ones", () => {
    expect(
      decodeHtmlEntities("&amp;&lt;&gt;&quot;&apos;&nbsp;&#65;&#x42;&copy;"),
    ).toBe("&<>\"' AB&copy;");
    expect(decodeHtmlEntities("&#0;&#xD800;&#99999999;")).toBe("���");
  });
});

describe("Venmo forwarder matching", () => {
  it("accepts the forwarding mailbox with or without a plus tag", () => {
    const forwarder = "pool.banker@gmail.com";
    expect(matchesForwarder("pool.banker@gmail.com", forwarder)).toBe(true);
    expect(matchesForwarder("Pool.Banker@Gmail.com", forwarder)).toBe(true);
    expect(
      matchesForwarder(
        "pool.banker+caf_=venmo-abc=mail.example.com@gmail.com",
        forwarder,
      ),
    ).toBe(true);
  });

  it("rejects other mailboxes, domains, and malformed addresses", () => {
    const forwarder = "pool.banker@gmail.com";
    for (const sender of [
      "pool.banker@gmail.com.example",
      "pool.banker@example.com",
      "other+pool.banker@gmail.com",
      "pool.bankerx@gmail.com",
      "pool.banker",
      "@gmail.com",
      "",
    ]) {
      expect(matchesForwarder(sender, forwarder)).toBe(false);
    }
    expect(matchesForwarder("pool.banker@gmail.com", "")).toBe(false);
    expect(matchesForwarder("@gmail.com", "@gmail.com")).toBe(false);
  });
});
