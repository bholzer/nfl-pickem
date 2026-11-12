import { useState } from "react";
import type {
  PaymentsData,
  VenmoAccount,
  VenmoAccountInput,
  VenmoImportResponse,
  VenmoImportResult,
} from "../shared/contracts";
import { useMutation } from "./api";
import {
  Field,
  fieldMessage,
  FormError,
  invalidProps,
  memberName,
  seasonQuery,
  type Member,
  type PaymentWriter,
} from "./payments-shared";

const MAX_STATEMENT_BYTES = 2 * 1024 * 1024;
const MAX_DISPLAY_NAMES = 5;

// RFC 3986: also escape the characters encodeURIComponent leaves alone.
function encode(value: string) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
}

/** The note a request or payment carries, so the payment files itself. */
export function venmoNote(season: number, keywords: readonly string[]) {
  const base = `Pick'em ${season}`;
  const keyword = keywords[0];
  return keyword && !base.toLowerCase().includes(keyword.toLowerCase())
    ? `${base} ${keyword}`
    : base;
}

/** Opens Venmo with a private charge (request) or payment filled in; it sends nothing. */
export function venmoLink({
  txn,
  username,
  amountCents,
  note,
}: {
  txn: "charge" | "pay";
  username: string;
  amountCents: number;
  note: string;
}) {
  const cents = Math.abs(Math.round(amountCents));
  const amount = `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
  const fields: [string, string][] = [
    ["txn", txn],
    ["audience", "private"],
    ["recipients", username.replace(/^@/, "")],
    ["amount", amount],
    ["note", note],
  ];
  const query = fields
    .map(([name, value]) => `${name}=${encode(value)}`)
    .join("&");
  return `https://venmo.com/?${query}`;
}

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

function importSummary(result: VenmoImportResult) {
  return [
    `${result.approved} approved`,
    plural(result.pending, "needs review", "need review"),
    `${result.duplicates} already imported`,
    `${result.skipped} skipped`,
  ].join(", ");
}

export function ImportStatement({
  data,
  write,
}: {
  data: PaymentsData;
  write: PaymentWriter;
}) {
  const importing = useMutation();
  const [file, setFile] = useState<File | null>(null);
  const [tooLarge, setTooLarge] = useState(false);
  const [result, setResult] = useState<VenmoImportResult | null>(null);
  const message = tooLarge
    ? "This file is larger than 2 MB. Download a shorter statement period from Venmo and try again."
    : fieldMessage(importing.error, "csv");
  return (
    <section className="panel" aria-labelledby="venmo-import-heading">
      <h2 id="venmo-import-heading" className="mb-2 font-semibold">
        Import a Venmo statement
      </h2>
      <p className="muted mb-4">
        Download a statement CSV from Venmo and upload it here. Payments already
        in the ledger are not imported twice.
      </p>
      <FormError error={importing.error} />
      {result && (
        <p role="status" className="alert success mb-4">
          Import finished: {importSummary(result)}.
        </p>
      )}
      <form
        className="page-toolbar mb-0"
        onSubmit={(event) => {
          event.preventDefault();
          if (!file || tooLarge) {
            return;
          }
          setResult(null);
          void file
            .text()
            .then((csv) =>
              write<VenmoImportResponse>(importing, {
                path: `/api/admin/payments/import${seasonQuery(data.season)}`,
                method: "POST",
                body: { csv },
              }),
            )
            .then((response) => {
              if (response) {
                setResult(response.result);
              }
            });
        }}
      >
        <Field id="venmo-csv" label="Statement CSV" message={message} wide>
          <input
            id="venmo-csv"
            className="input w-full"
            type="file"
            accept=".csv,text/csv"
            {...invalidProps("venmo-csv", message)}
            onChange={(event) => {
              const chosen = event.target.files?.[0] ?? null;
              setFile(chosen);
              setTooLarge(chosen !== null && chosen.size > MAX_STATEMENT_BYTES);
              setResult(null);
            }}
          />
        </Field>
        <button
          type="submit"
          className="button primary"
          disabled={importing.pending || !file || tooLarge}
        >
          Import statement
        </button>
      </form>
    </section>
  );
}

function splitList(text: string) {
  return text
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function KeywordsForm({
  data,
  write,
}: {
  data: PaymentsData;
  write: PaymentWriter;
}) {
  const saving = useMutation();
  const [text, setText] = useState(data.keywords.join(", "));
  const [saved, setSaved] = useState(false);
  const message = fieldMessage(saving.error, "keywords");
  return (
    <section className="panel" aria-labelledby="venmo-keywords-heading">
      <h2 id="venmo-keywords-heading" className="mb-2 font-semibold">
        Payment keywords
      </h2>
      <p className="muted mb-4">
        A Venmo payment is approved automatically only when its note contains a
        keyword and its Venmo name belongs to a player. Everything else waits
        for review.
      </p>
      <FormError error={saving.error} />
      {saved && (
        <p role="status" className="alert success mb-4">
          Keywords saved.
        </p>
      )}
      <form
        className="page-toolbar mb-0"
        onSubmit={(event) => {
          event.preventDefault();
          setSaved(false);
          void write(saving, {
            path: `/api/admin/payments/keywords${seasonQuery(data.season)}`,
            method: "PUT",
            body: { keywords: splitList(text) },
          }).then((response) => {
            setSaved(response !== null);
          });
        }}
      >
        <Field
          id="venmo-keywords"
          label="Keywords, separated by commas"
          message={message}
          wide
        >
          <input
            id="venmo-keywords"
            className="input w-full"
            type="text"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={text}
            {...invalidProps("venmo-keywords", message)}
            onChange={(event) => {
              setText(event.target.value);
              setSaved(false);
            }}
          />
        </Field>
        <button
          type="submit"
          className="button primary"
          disabled={saving.pending}
        >
          Save keywords
        </button>
      </form>
    </section>
  );
}

function accountInput(username: string, names: string): VenmoAccountInput {
  const trimmed = username.trim().replace(/^@/, "");
  return {
    username: trimmed || null,
    displayNames: names
      .split("\n")
      .map((name) => name.trim())
      .filter(Boolean),
  };
}

function AccountForm({
  member,
  account,
  pending,
  error,
  saved,
  onSave,
}: {
  member: Member;
  account: VenmoAccount | undefined;
  pending: boolean;
  error: unknown;
  saved: boolean;
  onSave: (input: VenmoAccountInput) => void;
}) {
  const [username, setUsername] = useState(account?.username ?? "");
  const [names, setNames] = useState(account?.displayNames.join("\n") ?? "");
  const [tooMany, setTooMany] = useState(false);
  const id = `venmo-${member.id}`;
  const name = memberName(member);
  const usernameMessage = fieldMessage(error, "username");
  const namesMessage = tooMany
    ? `Enter up to ${MAX_DISPLAY_NAMES} names.`
    : fieldMessage(error, "displayNames");
  return (
    <form
      aria-label={`Venmo for ${name}`}
      onSubmit={(event) => {
        event.preventDefault();
        const input = accountInput(username, names);
        const over = input.displayNames.length > MAX_DISPLAY_NAMES;
        setTooMany(over);
        if (!over) {
          onSave(input);
        }
      }}
    >
      <h3 className="mb-3 font-semibold">{name}</h3>
      <FormError error={error} />
      <div className="page-toolbar mb-0">
        <Field
          id={`${id}-username`}
          label="Venmo username"
          message={usernameMessage}
        >
          <input
            id={`${id}-username`}
            className="input w-48"
            type="text"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="@username"
            value={username}
            {...invalidProps(`${id}-username`, usernameMessage)}
            onChange={(event) => {
              setUsername(event.target.value);
            }}
          />
        </Field>
        <Field
          id={`${id}-names`}
          label="Venmo names, one per line"
          message={namesMessage}
          wide
        >
          <textarea
            id={`${id}-names`}
            className="input w-full"
            rows={2}
            value={names}
            {...invalidProps(`${id}-names`, namesMessage)}
            onChange={(event) => {
              setNames(event.target.value);
              setTooMany(false);
            }}
          />
        </Field>
        <button type="submit" className="button secondary" disabled={pending}>
          Save <span className="sr-only">Venmo for {name}</span>
        </button>
      </div>
      {saved && (
        <p role="status" className="mt-2 text-sm text-muted">
          Saved.
        </p>
      )}
    </form>
  );
}

/** Set up once: the names imports match on and the usernames links open. */
export function VenmoAccounts({
  data,
  write,
}: {
  data: PaymentsData;
  write: PaymentWriter;
}) {
  const saving = useMutation();
  const [active, setActive] = useState<{ id: number; saved: boolean } | null>(
    null,
  );
  const accounts = new Map(
    data.venmoAccounts.map((account) => [account.userId, account]),
  );
  return (
    <details className="panel setup-disclosure">
      <summary>
        <span>
          Venmo accounts{" "}
          <span className="font-normal text-muted">
            ({accounts.size} of {data.users.length} set up)
          </span>
        </span>
      </summary>
      <p className="muted mt-2">
        Names must match how each player appears on Venmo; the username is only
        used for Request and Pay links.
      </p>
      <ul className="venmo-accounts">
        {data.users.map((member) => {
          const account = accounts.get(member.id);
          const current = active?.id === member.id;
          return (
            <li key={`${member.id}:${JSON.stringify(account ?? null)}`}>
              <AccountForm
                member={member}
                account={account}
                pending={saving.pending}
                error={current ? saving.error : null}
                saved={current && active.saved}
                onSave={(input) => {
                  setActive({ id: member.id, saved: false });
                  void write(saving, {
                    path: `/api/admin/payments/venmo/${member.id}${seasonQuery(data.season)}`,
                    method: "PUT",
                    body: input,
                  }).then((response) => {
                    setActive({ id: member.id, saved: response !== null });
                  });
                }}
              />
            </li>
          );
        })}
      </ul>
    </details>
  );
}
