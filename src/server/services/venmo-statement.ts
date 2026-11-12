import type { PaymentDirection } from "../../shared/contracts";
import { normalizeVenmoName, type VenmoPayment } from "./venmo";

interface Field {
  value: string;
  /** Index of the delimiter, line break, or end of input after the field. */
  end: number;
}

function readUnquoted(input: string, start: number): Field {
  let end = start;
  while (end < input.length && !",\r\n".includes(input.charAt(end))) {
    end += 1;
  }
  return { value: input.slice(start, end), end };
}

/** `start` is just past the opening quote; an unterminated field runs to the end. */
function readQuoted(input: string, start: number): Field {
  let value = "";
  let position = start;
  for (;;) {
    const close = input.indexOf('"', position);
    if (close === -1) {
      return { value: value + input.slice(position), end: input.length };
    }
    value += input.slice(position, close);
    if (input.charAt(close + 1) !== '"') {
      // Tolerate stray text between the closing quote and the delimiter.
      const rest = readUnquoted(input, close + 1);
      return { value: value + rest.value, end: rest.end };
    }
    value += '"';
    position = close + 2;
  }
}

function readField(input: string, start: number): Field {
  return input.charAt(start) === '"'
    ? readQuoted(input, start + 1)
    : readUnquoted(input, start);
}

/**
 * RFC 4180 rows: quoted fields may contain commas, doubled quotes, and line
 * breaks. Accepts CRLF, LF, or CR line endings and a leading byte order mark.
 */
export function parseCsv(text: string): string[][] {
  const input = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const rows: string[][] = [];
  if (input === "") {
    return rows;
  }
  let row: string[] = [];
  let position = 0;
  for (;;) {
    const field = readField(input, position);
    row.push(field.value);
    position = field.end;
    if (input.charAt(position) === ",") {
      position += 1;
      continue;
    }
    rows.push(row);
    row = [];
    if (position >= input.length) {
      return rows;
    }
    position += input.startsWith("\r\n", position) ? 2 : 1;
    if (position >= input.length) {
      return rows;
    }
  }
}

type Column = "id" | "datetime" | "type" | "status" | "note" | "from" | "to";

interface Columns extends Partial<Record<Column, number>> {
  id: number;
  datetime: number;
  from: number;
  to: number;
  amount: number;
}

function findColumns(row: readonly string[]): Columns | null {
  const headers = row.map((cell) => cell.trim().toLowerCase());
  const index = (name: string) => {
    const found = headers.indexOf(name);
    return found === -1 ? undefined : found;
  };
  const amountIndex = headers.indexOf("amount (total)");
  const amount =
    amountIndex === -1
      ? headers.findIndex((header) => header.startsWith("amount"))
      : amountIndex;
  const [id, datetime, from, to] = ["id", "datetime", "from", "to"].map(index);
  if (
    id === undefined ||
    datetime === undefined ||
    from === undefined ||
    to === undefined ||
    amount === -1
  ) {
    return null;
  }
  return {
    id,
    datetime,
    from,
    to,
    amount,
    type: index("type"),
    status: index("status"),
    note: index("note"),
  };
}

const dateTimePattern =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?)(Z|[+-]\d{2}:\d{2})?$/;

/** Venmo writes local-looking times without a zone; they are treated as UTC. */
export function parseVenmoDateTime(raw: string): string | null {
  const match = dateTimePattern.exec(raw.trim());
  if (!match) {
    return null;
  }
  const [, year, month, day, time, zone] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
    string | undefined,
  ];
  // Date parsing rolls an impossible day such as February 30 into March.
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    date.getUTCMonth() !== Number(month) - 1 ||
    date.getUTCDate() !== Number(day)
  ) {
    return null;
  }
  const parsed = Date.parse(`${year}-${month}-${day}T${time}${zone ?? "Z"}`);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

const amountPattern = /^([+-])\$?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/;

/** `+ $5.00` or `- $1,250.00` as signed whole cents, without floating point. */
export function parseVenmoAmount(
  raw: string,
): { direction: PaymentDirection; amountCents: number } | null {
  const match = amountPattern.exec(raw.replace(/\s+/g, ""));
  if (!match) {
    return null;
  }
  const [, sign, dollars, cents = ""] = match as unknown as [
    string,
    string,
    string,
    string | undefined,
  ];
  const amountCents =
    Number(dollars.replaceAll(",", "")) * 100 + Number(cents.padEnd(2, "0"));
  if (!Number.isSafeInteger(amountCents) || amountCents === 0) {
    return null;
  }
  return { direction: sign === "+" ? "in" : "out", amountCents };
}

interface StatementRow {
  transactionId: string;
  type: "payment" | "charge";
  direction: PaymentDirection;
  amountCents: number;
  from: string;
  to: string;
  note: string | null;
  paidAt: string;
}

function cell(row: readonly string[], index: number | undefined): string {
  return index === undefined ? "" : (row[index] ?? "").trim();
}

/** Null for anything other than a settled person-to-person payment or charge. */
function statementRow(
  row: readonly string[],
  columns: Columns,
): StatementRow | null {
  const type = cell(row, columns.type).toLowerCase();
  const status = cell(row, columns.status).toLowerCase();
  const from = cell(row, columns.from);
  const to = cell(row, columns.to);
  const paidAt = parseVenmoDateTime(cell(row, columns.datetime));
  const amount = parseVenmoAmount(cell(row, columns.amount));
  if (
    (type !== "payment" && type !== "charge") ||
    (status !== "complete" && status !== "completed") ||
    !from ||
    !to ||
    !paidAt ||
    !amount
  ) {
    return null;
  }
  return {
    transactionId: cell(row, columns.id),
    type,
    ...amount,
    from,
    to,
    note: cell(row, columns.note) || null,
    paidAt,
  };
}

/**
 * The statement owner is the only name on every row. With a single row, or
 * rows that are all between the same two people, both names qualify and the
 * owner is unknown.
 */
function accountHolder(rows: readonly StatementRow[]): string | null {
  const [first, ...rest] = rows;
  if (!first || rest.length === 0) {
    return null;
  }
  const candidates = [first.from, first.to]
    .map(normalizeVenmoName)
    .filter((name) =>
      rest.every(
        (row) =>
          normalizeVenmoName(row.from) === name ||
          normalizeVenmoName(row.to) === name,
      ),
    );
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

/**
 * Without a known owner, the type and the sign identify the owner's side: a
 * Payment moves money from From to To, while a Charge is From requesting money
 * that To then pays. So money coming in is From's payment or a charge the owner
 * (From) made of To; money going out is the owner (From) paying To or paying a
 * charge From made.
 */
function counterparty(row: StatementRow, holder: string | null): string {
  if (holder !== null) {
    return normalizeVenmoName(row.from) === holder ? row.to : row.from;
  }
  const ownerIsFrom = (row.direction === "out") === (row.type === "payment");
  return ownerIsFrom ? row.to : row.from;
}

export type VenmoStatement =
  | { valid: true; payments: VenmoPayment[]; skipped: number }
  | { valid: false; error: string };

/**
 * Reads a Venmo account statement CSV. Columns are found by header name, so
 * preamble rows, extra columns, and summary rows are tolerated. Rows with a
 * transaction ID that are not settled payments or charges between two people
 * are counted as skipped; rows without an ID are ignored entirely.
 */
export function parseVenmoStatement(csv: string): VenmoStatement {
  const rows = parseCsv(csv);
  const headerIndex = rows.findIndex((row) => findColumns(row) !== null);
  const header = rows[headerIndex];
  const columns = header ? findColumns(header) : null;
  if (!columns) {
    return {
      valid: false,
      error:
        "No Venmo statement header row with ID, Datetime, From, To, and Amount columns",
    };
  }
  if (columns.type === undefined || columns.status === undefined) {
    return {
      valid: false,
      error: "The Venmo statement has no Type or Status column",
    };
  }
  const withIds = rows
    .slice(headerIndex + 1)
    .filter((row) => cell(row, columns.id) !== "");
  const kept = withIds.flatMap((row) => statementRow(row, columns) ?? []);
  const holder = accountHolder(kept);
  return {
    valid: true,
    payments: kept.map((row) => ({
      transactionId: row.transactionId,
      direction: row.direction,
      amountCents: row.amountCents,
      counterparty: counterparty(row, holder),
      note: row.note,
      paidAt: row.paidAt,
    })),
    skipped: withIds.length - kept.length,
  };
}
