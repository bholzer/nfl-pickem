import assert from "node:assert/strict";
import { env } from "cloudflare:workers";
import type { ForwardableEmailMessage } from "@cloudflare/workers-types";
import { describe, expect, it, vi } from "vitest";
import { ensureTokenUser } from "../../src/server/db";
import type { Env } from "../../src/server/env";
import worker from "../../src/server/index";
import { recordVenmoPayments } from "../../src/server/services/venmo-import";
import { parseVenmoStatement } from "../../src/server/services/venmo-statement";
import {
  replacePaymentKeywords,
  replaceVenmoAccount,
} from "../../src/server/venmo-accounts";
import type { ApiError, PaymentsData } from "../../src/shared/contracts";
import incomingFixture from "../fixtures/venmo-email-incoming.eml?raw";
import outgoingFixture from "../fixtures/venmo-email-outgoing.eml?raw";
import { app, login, mockEspn, origin, testEnv } from "./auth-helpers";

const inbox = "venmo-synthetic@mail.example.com";
const forwarder = "pool.banker@gmail.com";
const gmailSender =
  "pool.banker+caf_=venmo-synthetic=mail.example.com@gmail.com";
const emailEnv: Env = {
  ...env,
  MAINTENANCE_MODE: "false",
  VENMO_INBOX_ADDRESS: inbox,
  VENMO_FORWARDER_ADDRESS: forwarder,
};

interface FakeMessage extends ForwardableEmailMessage {
  rejection: () => string | null;
}

function emailMessage(
  raw: string,
  envelope: { from?: string; to?: string; rawSize?: number } = {},
): FakeMessage {
  const bytes = new TextEncoder().encode(raw);
  let rejection: string | null = null;
  const unexpected = () => Promise.reject(new Error("Unexpected email action"));
  return {
    from: envelope.from ?? gmailSender,
    to: envelope.to ?? inbox,
    rawSize: envelope.rawSize ?? bytes.byteLength,
    headers: new Headers(),
    raw: new Response(bytes).body ?? new ReadableStream(),
    setReject(reason: string) {
      rejection = reason;
    },
    forward: unexpected,
    reply: unexpected,
    rejection: () => rejection,
  };
}

async function deliver(
  raw: string,
  envelope: Parameters<typeof emailMessage>[1] = {},
  bindings: Env = emailEnv,
): Promise<FakeMessage> {
  const message = emailMessage(raw, envelope);
  await worker.email(message, bindings);
  return message;
}

/** Swaps the folded Subject header. */
function withSubject(raw: string, subject: string): string {
  return raw.replace(
    /^Subject:.*\r\n(?:[ \t].*\r\n)*/m,
    `Subject: ${subject}\r\n`,
  );
}

interface EntryRow {
  source: string;
  status: string;
  direction: string;
  amount_cents: number;
  user_id: number | null;
  venmo_name: string;
  note: string | null;
  paid_at: string;
  season: number;
  venmo_transaction_id: string;
}

async function entries(): Promise<EntryRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM payment_entries ORDER BY id",
  ).all<EntryRow>();
  return results;
}

async function failureCount(): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM venmo_email_failures",
  ).first<{ count: number }>();
  return row?.count ?? 0;
}

async function nothingWritten() {
  expect(await entries()).toEqual([]);
  expect(await failureCount()).toBe(0);
}

describe("Venmo email ingestion", () => {
  it("records an incoming payment as pending without a matching player", async () => {
    const message = await deliver(incomingFixture);
    expect(message.rejection()).toBeNull();
    expect(await entries()).toEqual([
      expect.objectContaining({
        source: "venmo_email",
        status: "pending",
        direction: "in",
        amount_cents: 500,
        user_id: null,
        venmo_name: "Casey Rivera",
        note: "Mo games",
        paid_at: "2026-11-12T02:22:16.000Z",
        season: 2026,
        venmo_transaction_id: "1AB23456CD789012E",
      }),
    ]);
  });

  it("approves an incoming payment from a known name with a keyword", async () => {
    const casey = await ensureTokenUser(env.DB, {
      discordId: "700000000000000003",
      username: "casey",
    });
    await replaceVenmoAccount(env.DB, casey.id, {
      username: null,
      displayNames: ["Casey Rivera"],
    });
    await replacePaymentKeywords(env.DB, ["games"]);
    await deliver(incomingFixture);
    expect(await entries()).toEqual([
      expect.objectContaining({ status: "approved", user_id: casey.id }),
    ]);
  });

  it("records an outgoing payment and ignores re-delivery", async () => {
    await deliver(outgoingFixture);
    await deliver(outgoingFixture);
    expect(await entries()).toEqual([
      expect.objectContaining({
        source: "venmo_email",
        direction: "out",
        amount_cents: 2000,
        venmo_transaction_id: "9ZY87654XW321098V",
      }),
    ]);
  });

  it("treats a payment already imported from a statement as a duplicate", async () => {
    const statement = parseVenmoStatement(
      [
        ",ID,Datetime,Type,Status,Note,From,To,Amount (total)",
        ",1AB23456CD789012E,2026-11-12T02:22:16,Payment,Complete,Mo games,Casey Rivera,Pool Banker,+ $5.00",
      ].join("\n"),
    );
    expect(statement.valid).toBe(true);
    if (statement.valid) {
      await recordVenmoPayments(env.DB, statement.payments, "venmo_csv");
    }
    await deliver(incomingFixture);
    expect(await entries()).toEqual([
      expect.objectContaining({ source: "venmo_csv" }),
    ]);
  });

  it("rejects unconfigured, misaddressed, unforwarded, and oversized email without writing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const cases: [Parameters<typeof emailMessage>[1], Env, string][] = [
      [{}, { ...emailEnv, VENMO_INBOX_ADDRESS: undefined }, "not_configured"],
      [{}, { ...emailEnv, VENMO_FORWARDER_ADDRESS: " " }, "not_configured"],
      [{ to: "other@mail.example.com" }, emailEnv, "recipient_mismatch"],
      [{ from: "venmo@venmo.com" }, emailEnv, "forwarder_mismatch"],
      [{ from: "pool.banker@example.com" }, emailEnv, "forwarder_mismatch"],
      [{ rawSize: 1024 * 1024 + 1 }, emailEnv, "too_large"],
    ];
    for (const [envelope, bindings, reason] of cases) {
      const message = await deliver(incomingFixture, envelope, bindings);
      expect(message.rejection()).toEqual(expect.any(String));
      expect(warn).toHaveBeenLastCalledWith("Venmo email rejected", { reason });
    }
    const upperCase = await deliver(incomingFixture, {
      to: inbox.toUpperCase(),
      from: forwarder.toUpperCase(),
    });
    expect(upperCase.rejection()).toBeNull();
    expect(await entries()).toHaveLength(1);
    expect(await failureCount()).toBe(0);
  });

  it("drops email whose From header is not Venmo", async () => {
    for (const from of [
      "Venmo <venmo@venmo.com.example>",
      '"venmo@venmo.com" <someone@example.com>',
      "Venmo <alerts@venmo.com>",
    ]) {
      const message = await deliver(
        incomingFixture.replace(
          "From: Venmo <venmo@venmo.com>",
          `From: ${from}`,
        ),
      );
      expect(message.rejection()).toBeNull();
    }
    await nothingWritten();
  });

  it("drops non-payment Venmo email silently", async () => {
    await deliver(withSubject(incomingFixture, "Casey Rivera requests $5.00"));
    await nothingWritten();
  });

  it("keeps an unreadable payment email for review until dismissed", async () => {
    const long = `Casey Rivera paid your $5.00 request ${"x".repeat(300)}`;
    const message = await deliver(withSubject(incomingFixture, long));
    expect(message.rejection()).toBeNull();
    expect(await entries()).toEqual([]);

    const admin = await login("333333333333333333", true);
    mockEspn({ season: 2026, type: 2, week: 1 }, {});
    const read = await app.request(
      `${origin}/api/admin/payments?season=2026`,
      { headers: admin.headers },
      testEnv,
    );
    const { emailFailures } = await read.json<PaymentsData>();
    expect(emailFailures).toHaveLength(1);
    const [failure] = emailFailures;
    assert(failure);
    expect(failure).toMatchObject({
      subject: long.slice(0, 200),
      reason: "The subject is not a recognized Venmo payment format",
    });
    expect(Date.parse(failure.receivedAt)).not.toBeNaN();
    const dismiss = (id: number, headers = admin.headers) =>
      app.request(
        `${origin}/api/admin/payments/email-failures/${id}/dismiss?season=2026`,
        { method: "POST", headers },
        testEnv,
      );
    const member = await login();
    expect((await dismiss(failure.id, member.headers)).status).toBe(403);
    const dismissed = await dismiss(failure.id);
    expect(dismissed.status).toBe(200);
    expect((await dismissed.json<PaymentsData>()).emailFailures).toEqual([]);
    const again = await dismiss(failure.id);
    expect(again.status).toBe(409);
    expect((await again.json<ApiError>()).error).toBe(
      "The email failure was already dismissed",
    );
    expect((await dismiss(9999)).status).toBe(404);
    expect((await dismiss(0)).status).toBe(400);
  });

  it("fails delivery temporarily during maintenance without writing", async () => {
    await expect(
      deliver(incomingFixture, {}, { ...emailEnv, MAINTENANCE_MODE: "true" }),
    ).rejects.toThrow("Writes are paused for maintenance");
    await nothingWritten();
  });
});
