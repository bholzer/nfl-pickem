import type { PaymentDirection } from "../../shared/contracts";
import type { VenmoPayment } from "./venmo";
import { parseVenmoAmount } from "./venmo-statement";

/** The decoded parts of a Venmo notification email that the parser reads. */
export interface VenmoEmail {
  subject: string;
  html: string;
  /** Venmo's plain-text part is empty; accepted for completeness only. */
  text: string;
  /** The `Date:` header, or null when the message had none. */
  date: string | null;
  /** When the message arrived; the payment time when `date` is unusable. */
  receivedAt: string;
}

export type VenmoEmailResult =
  | { ok: true; payment: VenmoPayment }
  | {
      ok: false;
      /** True when the email announces a payment that could not be read. */
      paymentLike: boolean;
      reason: string;
    };

interface Heading {
  direction: PaymentDirection;
  name: string;
  amountCents: number;
}

/** Dollars with optional thousands separators and cents, right after `$`. */
const amount = String.raw`\$(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?(?!\d)`;
const subjectPatterns: readonly [PaymentDirection, RegExp][] = [
  ["out", new RegExp(String.raw`^You paid (.+?) ${amount}\.?$`, "i")],
  [
    "in",
    new RegExp(
      String.raw`^(.+?) paid ${amount} to your Venmo account\.(?: .*)?$`,
      "i",
    ),
  ],
  ["in", new RegExp(String.raw`^(.+?) paid you ${amount}\.?$`, "i")],
];
/** Body headings; the name in them is not reliable, only the amount is. */
const headingPatterns: readonly [PaymentDirection, RegExp][] = [
  ["out", new RegExp(String.raw`\bYou paid .{1,100}? ${amount}`, "gi")],
  ["in", new RegExp(String.raw`\bpaid you ${amount}`, "gi")],
];
const transactionIdPattern = /\bTransaction ID\s+([0-9A-Za-z]+)/;
const validTransactionId = /^[0-9A-Z]{8,40}$/;
const notePattern =
  /<([a-z][a-z0-9]*)\b[^>]*\bclass\s*=\s*["']?[^"'>]*\btransaction-note\b[^>]*>([\s\S]*?)<\/\1\s*>/i;
const titlePattern = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i;
const MAX_NAME_LENGTH = 100;

const namedEntities: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function codePoint(value: number): string {
  const valid =
    Number.isInteger(value) &&
    value > 0 &&
    value <= 0x10ffff &&
    (value < 0xd800 || value > 0xdfff);
  return valid ? String.fromCodePoint(value) : "�";
}

/** Decimal and hexadecimal references plus the basic named entities. */
export function decodeHtmlEntities(text: string): string {
  return text.replace(
    /&(?:#(\d{1,8})|#x([0-9a-f]{1,8})|([a-z]+));/gi,
    (match, decimal?: string, hex?: string, name?: string) => {
      if (decimal !== undefined) {
        return codePoint(Number.parseInt(decimal, 10));
      }
      if (hex !== undefined) {
        return codePoint(Number.parseInt(hex, 16));
      }
      return namedEntities[(name ?? "").toLowerCase()] ?? match;
    },
  );
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Visible text of an HTML fragment: tags become spaces, entities decode. */
function htmlText(html: string): string {
  const withoutHidden = html.replace(
    /<(style|script|head)\b[\s\S]*?<\/\1\s*>/gi,
    " ",
  );
  return collapse(decodeHtmlEntities(withoutHidden.replace(/<[^>]*>/g, " ")));
}

function cents(dollars: string, fraction: string | undefined): number | null {
  return (
    parseVenmoAmount(
      `+${dollars}${fraction === undefined ? "" : `.${fraction}`}`,
    )?.amountCents ?? null
  );
}

function subjectHeading(subject: string): Heading | null {
  for (const [direction, pattern] of subjectPatterns) {
    const match = pattern.exec(subject);
    if (!match) {
      continue;
    }
    const [, rawName = "", dollars = "", fraction] = match;
    const name = collapse(rawName);
    const amountCents = cents(dollars, fraction);
    const valid =
      amountCents !== null &&
      name !== "" &&
      name.length <= MAX_NAME_LENGTH &&
      !(direction === "in" && name.toLowerCase() === "you");
    return valid ? { direction, name, amountCents } : null;
  }
  return null;
}

/** Every amount the HTML's title and headings announce, with its direction. */
function bodyAmounts(html: string): Omit<Heading, "name">[] {
  const title = titlePattern.exec(html)?.[1] ?? "";
  const text = `${collapse(decodeHtmlEntities(title.replace(/<[^>]*>/g, " ")))} ${htmlText(html)}`;
  return headingPatterns.flatMap(([direction, pattern]) =>
    [...text.matchAll(pattern)].flatMap(([, dollars = "", fraction]) => {
      const amountCents = cents(dollars, fraction);
      return amountCents === null ? [] : [{ direction, amountCents }];
    }),
  );
}

function transactionId(html: string): string | null {
  const id = transactionIdPattern.exec(htmlText(html))?.[1];
  return id !== undefined && validTransactionId.test(id) ? id : null;
}

function transactionNote(html: string): string | null {
  const inner = notePattern.exec(html)?.[2];
  if (inner === undefined) {
    return null;
  }
  const note = collapse(decodeHtmlEntities(inner.replace(/<[^>]*>/g, " ")));
  return note === "" ? null : note;
}

function paidAt(email: VenmoEmail): string {
  const parsed = email.date === null ? Number.NaN : Date.parse(email.date);
  return Number.isNaN(parsed)
    ? new Date(email.receivedAt).toISOString()
    : new Date(parsed).toISOString();
}

function failure(reason: string): VenmoEmailResult {
  return { ok: false, paymentLike: true, reason };
}

/**
 * Reads a completed Venmo payment from its notification email. The subject
 * gives the direction, the counterparty (with the casing Venmo's body loses),
 * and the amount; the HTML gives the transaction ID and the note. Only
 * subjects mentioning "paid" count as payment notices: anything else, such as
 * requests, transfers, or marketing, is not payment-like.
 */
export function parseVenmoEmail(email: VenmoEmail): VenmoEmailResult {
  const subject = collapse(email.subject);
  if (!/\bpaid\b/i.test(subject)) {
    return {
      ok: false,
      paymentLike: false,
      reason: "Not a payment notification",
    };
  }
  const heading = subjectHeading(subject);
  if (!heading) {
    return failure("The subject is not a recognized Venmo payment format");
  }
  const disagreeing = bodyAmounts(email.html).some(
    (body) =>
      body.direction !== heading.direction ||
      body.amountCents !== heading.amountCents,
  );
  if (disagreeing) {
    return failure("The email body does not match the subject's payment");
  }
  const id = transactionId(email.html);
  if (id === null) {
    return failure("The email has no Venmo transaction ID");
  }
  return {
    ok: true,
    payment: {
      transactionId: id,
      direction: heading.direction,
      amountCents: heading.amountCents,
      counterparty: heading.name,
      note: transactionNote(email.html),
      paidAt: paidAt(email),
    },
  };
}

function splitAddress(address: string): { local: string; domain: string } {
  const at = address.lastIndexOf("@");
  return at === -1
    ? { local: "", domain: "" }
    : {
        local: address.slice(0, at).toLowerCase(),
        domain: address.slice(at + 1).toLowerCase(),
      };
}

/**
 * Whether an envelope sender is the configured forwarding mailbox. Gmail's
 * auto-forwarding rewrites the envelope sender to `local+caf_=...@gmail.com`,
 * so a `+tag` on the sender is ignored; the domain must match exactly.
 */
export function matchesForwarder(
  envelopeFrom: string,
  forwarder: string,
): boolean {
  const sender = splitAddress(envelopeFrom.trim());
  const expected = splitAddress(forwarder.trim());
  const plus = sender.local.indexOf("+");
  const senderLocal = plus === -1 ? sender.local : sender.local.slice(0, plus);
  return (
    expected.local !== "" &&
    expected.domain !== "" &&
    sender.domain === expected.domain &&
    senderLocal === expected.local
  );
}
