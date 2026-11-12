import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  classifyVenmoPayment,
  normalizeVenmoName,
} from "../../src/server/services/venmo";
import {
  parseCsv,
  parseVenmoAmount,
  parseVenmoDateTime,
  parseVenmoStatement,
} from "../../src/server/services/venmo-statement";

const fixture = readFileSync(
  new URL("../fixtures/venmo-statement.csv", import.meta.url),
  "utf8",
);

const header = ",ID,Datetime,Type,Status,Note,From,To,Amount (total)";

function statement(...rows: string[]): string {
  return ["Account Statement - (@Someone)", header, ...rows].join("\n");
}

describe("Venmo payment classification", () => {
  const owners = new Map([
    ["avery quinn", 1],
    ["jordan blake", 2],
  ]);
  const keywords = ["pickem", "nfl"];

  it("approves only a known name whose note mentions a keyword", () => {
    expect(
      classifyVenmoPayment(
        { counterparty: "  AVERY   Quinn ", note: "PickEm week 2" },
        owners,
        keywords,
      ),
    ).toEqual({ status: "approved", userId: 1 });
    expect(
      classifyVenmoPayment(
        { counterparty: "Jordan Blake", note: "my NFL picks" },
        owners,
        keywords,
      ),
    ).toEqual({ status: "approved", userId: 2 });
  });

  it("leaves a known name without a keyword pending with the player filled in", () => {
    expect(
      classifyVenmoPayment(
        { counterparty: "Avery Quinn", note: "pizza" },
        owners,
        keywords,
      ),
    ).toEqual({ status: "pending", userId: 1 });
    expect(
      classifyVenmoPayment(
        { counterparty: "Avery Quinn", note: null },
        owners,
        keywords,
      ),
    ).toEqual({ status: "pending", userId: 1 });
    expect(
      classifyVenmoPayment(
        { counterparty: "Avery Quinn", note: "pickem" },
        owners,
        [],
      ),
    ).toEqual({ status: "pending", userId: 1 });
  });

  it("leaves an unknown name pending without a player even with a keyword", () => {
    expect(
      classifyVenmoPayment(
        { counterparty: "Avery Q", note: "pickem" },
        owners,
        keywords,
      ),
    ).toEqual({ status: "pending", userId: null });
  });

  it("normalizes names by trimming, collapsing spaces, and lowercasing", () => {
    expect(normalizeVenmoName("  Mary  Ann\tSmith ")).toBe("mary ann smith");
  });
});

describe("CSV rows", () => {
  it("handles quotes, embedded delimiters, line breaks, CRLF, and a BOM", () => {
    expect(
      parseCsv('\uFEFFa,"b,c","say ""hi""\r\nthere"\r\n,x,\r\n"last"'),
    ).toEqual([["a", "b,c", 'say "hi"\r\nthere'], ["", "x", ""], ["last"]]);
  });

  it("handles LF, CR, trailing separators, and blank lines", () => {
    expect(parseCsv("a\n\nb,\rc\n")).toEqual([["a"], [""], ["b", ""], ["c"]]);
    expect(parseCsv("a,")).toEqual([["a", ""]]);
    expect(parseCsv("")).toEqual([]);
  });

  it("keeps an unterminated quoted field and text after a closing quote", () => {
    expect(parseCsv('"ab"c,d\n"open')).toEqual([["abc", "d"], ["open"]]);
  });
});

describe("Venmo statement values", () => {
  it("parses signed amounts to whole cents", () => {
    expect(parseVenmoAmount("+ $5.00")).toEqual({
      direction: "in",
      amountCents: 500,
    });
    expect(parseVenmoAmount("- $1,250.00")).toEqual({
      direction: "out",
      amountCents: 125000,
    });
    expect(parseVenmoAmount("+$0.29")).toEqual({
      direction: "in",
      amountCents: 29,
    });
    expect(parseVenmoAmount("-$7.1")).toEqual({
      direction: "out",
      amountCents: 710,
    });
    expect(parseVenmoAmount("+ $1234")).toEqual({
      direction: "in",
      amountCents: 123400,
    });
    for (const invalid of [
      "$5.00",
      "+ $0.00",
      "+ $5.001",
      "+ $1,25.00",
      "",
      "+ $",
      "five",
    ]) {
      expect(parseVenmoAmount(invalid)).toBeNull();
    }
  });

  it("treats zoneless times as UTC and rejects impossible dates", () => {
    expect(parseVenmoDateTime("2026-09-10T18:22:11")).toBe(
      "2026-09-10T18:22:11.000Z",
    );
    expect(parseVenmoDateTime(" 2026-09-10 18:22 ")).toBe(
      "2026-09-10T18:22:00.000Z",
    );
    expect(parseVenmoDateTime("2026-09-10T18:22:11-04:00")).toBe(
      "2026-09-10T22:22:11.000Z",
    );
    for (const invalid of [
      "2026-02-30T12:00:00",
      "2026-09-10T25:00:00",
      "2026-09-10",
      "09/10/2026",
    ]) {
      expect(parseVenmoDateTime(invalid)).toBeNull();
    }
  });
});

describe("Venmo statements", () => {
  it("reads the synthetic statement fixture", () => {
    expect(parseVenmoStatement(fixture)).toEqual({
      valid: true,
      skipped: 4,
      payments: [
        {
          transactionId: "4100000000000000001",
          direction: "in",
          amountCents: 500,
          counterparty: "Avery Quinn",
          note: "Pickem week 1, thanks!",
          paidAt: "2026-09-10T18:22:11.000Z",
        },
        {
          transactionId: "4100000000000000002",
          direction: "in",
          amountCents: 1500,
          counterparty: "Jordan Blake",
          note: 'Pickem fees "weeks 1-3"',
          paidAt: "2026-09-11T01:05:00.000Z",
        },
        {
          transactionId: "4100000000000000003",
          direction: "in",
          amountCents: 125050,
          counterparty: "Casey Morgan",
          note: "Dinner\nsplit",
          paidAt: "2026-09-12T09:00:00.000Z",
        },
        {
          transactionId: "4100000000000000004",
          direction: "out",
          amountCents: 2000,
          counterparty: "Avery Quinn",
          note: "pickem week 1 winnings",
          paidAt: "2026-09-14T16:30:00.000Z",
        },
        {
          transactionId: "4100000000000000007",
          direction: "out",
          amountCents: 500,
          counterparty: "Taylor Reed",
          note: "Pickem buy-in",
          paidAt: "2026-09-16T10:00:00.000Z",
        },
        {
          transactionId: "4100000000000000008",
          direction: "in",
          amountCents: 1000,
          counterparty: "Jordan Blake",
          note: "pickem playoffs",
          paidAt: "2027-01-05T03:15:00.000Z",
        },
      ],
    });
  });

  it("maps columns by header name in any order and case", () => {
    const csv = [
      "amount (TOTAL) , status,TO,from, type ,note,datetime,id,extra",
      "+ $3.00,Complete,Owner Name,Pat Doe,Payment,,2026-10-01T00:00:00,77,x",
      "- $4.00,Complete,Pat Doe,Owner Name,Payment,lunch,2026-10-02T00:00:00,78,y",
    ].join("\r\n");
    expect(parseVenmoStatement(`\uFEFF${csv}\r\n`)).toEqual({
      valid: true,
      skipped: 0,
      payments: [
        expect.objectContaining({
          transactionId: "77",
          direction: "in",
          counterparty: "Pat Doe",
          note: null,
        }),
        expect.objectContaining({
          transactionId: "78",
          direction: "out",
          counterparty: "Pat Doe",
          note: "lunch",
        }),
      ],
    });
  });

  it("finds the account holder as the one name on every row", () => {
    // Pat both pays and charges the owner; only the owner is on every row.
    const result = parseVenmoStatement(
      statement(
        ",1,2026-10-01T00:00:00,Charge,Complete,,Pat Doe,Owner Name,- $3.00",
        ",2,2026-10-02T00:00:00,Payment,Complete,,Lee Roe,owner name,+ $4.00",
      ),
    );
    expect(result.valid && result.payments.map((p) => p.counterparty)).toEqual([
      "Pat Doe",
      "Lee Roe",
    ]);
  });

  it("falls back to the type and sign when the holder is ambiguous", () => {
    const cases: [string, string, string][] = [
      // Money in: a payment from From, or the owner (From) charging To.
      ["Payment", "+ $1.00", "Pat Doe"],
      ["Charge", "+ $1.00", "Lee Roe"],
      // Money out: the owner (From) paying To, or paying From's charge.
      ["Payment", "- $1.00", "Lee Roe"],
      ["Charge", "- $1.00", "Pat Doe"],
    ];
    for (const [type, amount, counterparty] of cases) {
      const result = parseVenmoStatement(
        statement(
          `,9,2026-10-01T00:00:00,${type},Complete,,Pat Doe,Lee Roe,${amount}`,
        ),
      );
      expect(result).toEqual({
        valid: true,
        skipped: 0,
        payments: [expect.objectContaining({ counterparty })],
      });
    }
    // Two rows between the same two people are just as ambiguous.
    const pair = parseVenmoStatement(
      statement(
        ",1,2026-10-01T00:00:00,Payment,Complete,,Pat Doe,Lee Roe,+ $1.00",
        ",2,2026-10-02T00:00:00,Payment,Complete,,Lee Roe,Pat Doe,- $1.00",
      ),
    );
    expect(pair.valid && pair.payments.map((p) => p.counterparty)).toEqual([
      "Pat Doe",
      "Pat Doe",
    ]);
  });

  it("skips incomplete, non-payment, nameless, and unparseable rows", () => {
    const result = parseVenmoStatement(
      statement(
        ",1,2026-10-01T00:00:00,Payment,Pending,,Pat Doe,Lee Roe,+ $1.00",
        ",2,2026-10-01T00:00:00,Standard Transfer,Complete,,Pat Doe,Lee Roe,+ $1.00",
        ",3,2026-10-01T00:00:00,Payment,Complete,,,Lee Roe,+ $1.00",
        ",4,2026-10-01T00:00:00,Payment,Complete,,Pat Doe,,+ $1.00",
        ",5,yesterday,Payment,Complete,,Pat Doe,Lee Roe,+ $1.00",
        ",6,2026-10-01T00:00:00,Payment,Complete,,Pat Doe,Lee Roe,$1.00",
        ",7,2026-10-01T00:00:00,Payment,Complete,,Pat Doe,Lee Roe",
        ",,2026-10-01T00:00:00,Payment,Complete,,Pat Doe,Lee Roe,+ $1.00",
        "",
        "Disclaimer text with no ID",
      ),
    );
    expect(result).toEqual({ valid: true, skipped: 7, payments: [] });
  });

  it("rejects input without a statement header", () => {
    for (const csv of [
      "",
      "not,a,statement",
      "ID,Datetime,From,To\n1,2026-10-01T00:00:00,a,b",
    ]) {
      expect(parseVenmoStatement(csv)).toEqual({
        valid: false,
        error: expect.stringContaining("header") as unknown,
      });
    }
    expect(parseVenmoStatement("ID,Datetime,From,To,Amount (total)\n")).toEqual(
      {
        valid: false,
        error: expect.stringContaining("Type or Status") as unknown,
      },
    );
  });
});
