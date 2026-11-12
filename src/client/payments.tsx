import { useEffect, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import type {
  ManualPaymentInput,
  PaymentDirection,
  PaymentEntry,
  PaymentPlayerBalance,
  PaymentPoolSummary,
  PaymentSource,
  PaymentStatus,
  PaymentsData,
} from "../shared/contracts";
import { errorMessage, RequestError, useMutation, useResource } from "./api";
import {
  ErrorNotice,
  OptionPicker,
  PageHeading,
  ResourceView,
  SeasonPicker,
  usd,
} from "./ui";

type Member = PaymentsData["users"][number];

const paidDate = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  month: "short",
  day: "numeric",
  year: "numeric",
});
// en-CA formats as YYYY-MM-DD, the value a date input expects.
const inputDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Chicago",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const directionLabels: Record<PaymentDirection, string> = {
  in: "Received from player",
  out: "Paid to player",
};
const sourceLabels: Record<PaymentSource, string> = {
  manual: "Manual",
  venmo_email: "Venmo email",
  venmo_csv: "Venmo CSV",
  carryover: "Carryover",
};
const statusLabels: Record<PaymentStatus, string> = {
  approved: "Approved",
  pending: "Pending review",
  ignored: "Ignored",
  voided: "Voided",
};

function memberName(member: Pick<Member, "username"> | undefined) {
  return member?.username ?? "Pool member";
}

/** Literal wording, so the balance never depends on a sign or color alone. */
function balanceLabel(
  player: Pick<PaymentPlayerBalance, "banker" | "balanceCents">,
) {
  if (player.banker || player.balanceCents === 0) {
    return "Settled";
  }
  return player.balanceCents < 0
    ? `Owes ${usd(-player.balanceCents)}`
    : `You owe ${usd(player.balanceCents)}`;
}

function balanceGroup(player: PaymentPlayerBalance) {
  if (player.banker || player.balanceCents === 0) {
    return 2;
  }
  return player.balanceCents < 0 ? 0 : 1;
}

// Players who owe come first, then players you owe, largest amounts first,
// then settled rows; the server's username order breaks every tie.
function sortPlayers(players: PaymentPlayerBalance[]) {
  return players
    .map((player, index) => ({ player, index }))
    .sort(
      (a, b) =>
        balanceGroup(a.player) - balanceGroup(b.player) ||
        Math.abs(b.player.balanceCents) - Math.abs(a.player.balanceCents) ||
        a.index - b.index,
    )
    .map(({ player }) => player);
}

function fieldMessage(error: unknown, field: string) {
  return error instanceof RequestError ? error.fields[field] : undefined;
}

function FieldMessage({ id, message }: { id: string; message?: string }) {
  return message ? (
    <p id={id} className="field-error">
      {message}
    </p>
  ) : null;
}

// Field messages sit beside their controls; this carries the summary.
function FormError({ error }: { error: unknown }) {
  return error ? (
    <p role="alert" className="alert error mb-4">
      {errorMessage(error)}
    </p>
  ) : null;
}

function PaymentSummary({ summary }: { summary: PaymentPoolSummary }) {
  const items: { label: string; value: number; note?: string }[] = [
    { label: "Collected", value: summary.collectedCents },
    { label: "Paid out", value: summary.paidOutCents },
    { label: "Owed to you", value: summary.owedToBankerCents },
    { label: "You owe", value: summary.owedByBankerCents },
    {
      label: "Unawarded pots",
      value: summary.unawardedCents,
      note: "Pot money with no winner, held by the banker.",
    },
  ];
  return (
    <section aria-label="Pool money" className="panel">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-5">
        {items.map((item) => (
          <div key={item.label} className="min-w-0">
            <dt className="stat-label">{item.label}</dt>
            <dd className="mt-1 text-lg font-semibold tabular-nums">
              {usd(item.value)}
            </dd>
            {item.note && <dd className="muted">{item.note}</dd>}
          </div>
        ))}
      </dl>
    </section>
  );
}

function PlayerRow({ player }: { player: PaymentPlayerBalance }) {
  return (
    <tr>
      <th scope="row">
        <span className="standing-player">
          <span className="min-w-0">{memberName(player.user)}</span>{" "}
          {player.banker && <span className="you-badge">Banker</span>}
        </span>
      </th>
      <td>{usd(player.feesCents)}</td>
      <td>{usd(player.winningsCents)}</td>
      <td>{usd(player.paidInCents)}</td>
      <td>{usd(player.paidOutCents)}</td>
      <td className="font-semibold">{balanceLabel(player)}</td>
    </tr>
  );
}

function PlayerBalances({ data }: { data: PaymentsData }) {
  if (!data.players.length) {
    return (
      <p className="muted">
        Nobody has played or paid in the {data.season} season yet.
      </p>
    );
  }
  return (
    <div
      className="table-scroll"
      tabIndex={0}
      role="region"
      aria-label="Player balances"
    >
      <table className="standings-table season-table">
        <caption className="sr-only">{data.season} season balances</caption>
        <thead>
          <tr>
            <th scope="col">Player</th>
            <th scope="col">Fees</th>
            <th scope="col">Winnings</th>
            <th scope="col">Paid in</th>
            <th scope="col">Paid out</th>
            <th scope="col">Balance</th>
          </tr>
        </thead>
        <tbody>
          {sortPlayers(data.players).map((player) => (
            <PlayerRow key={player.user.id} player={player} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function memberOptions(users: Member[]) {
  return users.map((member) => ({
    value: String(member.id),
    label: memberName(member),
  }));
}

function BankerPicker({
  data,
  pending,
  error,
  onSave,
}: {
  data: PaymentsData;
  pending: boolean;
  error: unknown;
  onSave: (userId: number | null) => void;
}) {
  const message = fieldMessage(error, "userId");
  return (
    <div className="period-select">
      <span>Banker</span>
      <OptionPicker
        label="Banker"
        value={data.bankerUserId === null ? "" : String(data.bankerUserId)}
        disabled={pending}
        invalid={Boolean(message)}
        describedBy={message ? "banker-error" : undefined}
        options={[{ value: "", label: "None" }, ...memberOptions(data.users)]}
        onChange={(value) => {
          onSave(value ? Number(value) : null);
        }}
      />
      <FieldMessage id="banker-error" message={message} />
    </div>
  );
}

function today() {
  return inputDate.format(new Date());
}

interface EntryDraft {
  userId: string;
  direction: PaymentDirection;
  amount: string;
  date: string;
  note: string;
}

function blankDraft(): EntryDraft {
  return { userId: "", direction: "in", amount: "", date: today(), note: "" };
}

function draftInput(season: number, draft: EntryDraft): ManualPaymentInput {
  return {
    season,
    userId: Number(draft.userId),
    direction: draft.direction,
    // Dollars round to whole cents; the server rejects anything else.
    amountCents: Math.round(Number(draft.amount) * 100),
    // Noon UTC is the same calendar day in every US time zone.
    paidAt: `${draft.date}T12:00:00.000Z`,
    note: draft.note.trim() || null,
  };
}

function Field({
  id,
  label,
  message,
  wide = false,
  children,
}: {
  id: string;
  label: string;
  message?: string;
  wide?: boolean;
  children: ReactNode;
}) {
  // A wide field takes the full row on phones instead of overflowing it.
  return (
    <div className={wide ? "period-select w-full sm:w-64" : "period-select"}>
      <label htmlFor={id}>{label}</label>
      {children}
      <FieldMessage id={`${id}-error`} message={message} />
    </div>
  );
}

function invalidProps(id: string, message: string | undefined) {
  return {
    "aria-invalid": message ? true : undefined,
    "aria-describedby": message ? `${id}-error` : undefined,
  };
}

function EntryForm({
  data,
  pending,
  error,
  onSubmit,
}: {
  data: PaymentsData;
  pending: boolean;
  error: unknown;
  onSubmit: (input: ManualPaymentInput) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(blankDraft);
  const [missingPlayer, setMissingPlayer] = useState(false);
  const update = (change: Partial<EntryDraft>) => {
    setDraft((current) => ({ ...current, ...change }));
  };
  const playerMessage = missingPlayer
    ? "Choose a player"
    : fieldMessage(error, "userId");
  const amountMessage = fieldMessage(error, "amountCents");
  const dateMessage = fieldMessage(error, "paidAt");
  const noteMessage = fieldMessage(error, "note");
  return (
    <section className="panel" aria-labelledby="payment-form-heading">
      <h2 id="payment-form-heading" className="mb-4 font-semibold">
        Record a payment
      </h2>
      <FormError error={error} />
      <form
        className="page-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          if (!draft.userId) {
            setMissingPlayer(true);
            return;
          }
          void onSubmit(draftInput(data.season, draft)).then((saved) => {
            if (saved) {
              setDraft(blankDraft());
            }
          });
        }}
      >
        <div className="period-select">
          <span>Player</span>
          <OptionPicker
            label="Player"
            value={draft.userId}
            invalid={Boolean(playerMessage)}
            describedBy={playerMessage ? "payment-player-error" : undefined}
            options={[
              { value: "", label: "Choose a player" },
              ...memberOptions(data.users),
            ]}
            onChange={(userId) => {
              setMissingPlayer(false);
              update({ userId });
            }}
          />
          <FieldMessage id="payment-player-error" message={playerMessage} />
        </div>
        <div className="period-select">
          <span>Direction</span>
          <OptionPicker
            label="Direction"
            value={draft.direction}
            options={(["in", "out"] as const).map((value) => ({
              value,
              label: directionLabels[value],
            }))}
            onChange={(value) => {
              update({ direction: value === "out" ? "out" : "in" });
            }}
          />
        </div>
        <Field
          id="payment-amount"
          label="Amount in dollars"
          message={amountMessage}
        >
          <input
            id="payment-amount"
            className="input w-32"
            type="number"
            inputMode="decimal"
            min="0.01"
            max="10000"
            step="0.01"
            required
            value={draft.amount}
            {...invalidProps("payment-amount", amountMessage)}
            onChange={(event) => {
              update({ amount: event.target.value });
            }}
          />
        </Field>
        <Field id="payment-date" label="Date paid" message={dateMessage}>
          <input
            id="payment-date"
            className="input"
            type="date"
            required
            value={draft.date}
            {...invalidProps("payment-date", dateMessage)}
            onChange={(event) => {
              update({ date: event.target.value });
            }}
          />
        </Field>
        <Field
          id="payment-note"
          label="Note (optional)"
          message={noteMessage}
          wide
        >
          <input
            id="payment-note"
            className="input w-full"
            type="text"
            maxLength={280}
            value={draft.note}
            {...invalidProps("payment-note", noteMessage)}
            onChange={(event) => {
              update({ note: event.target.value });
            }}
          />
        </Field>
        <button type="submit" className="button primary" disabled={pending}>
          Record payment
        </button>
      </form>
    </section>
  );
}

function entryDescription(entry: PaymentEntry, users: Map<number, Member>) {
  const player =
    entry.userId === null
      ? "an unmatched sender"
      : memberName(users.get(entry.userId));
  const verb = entry.direction === "in" ? "received from" : "paid to";
  return `${usd(entry.amountCents)} ${verb} ${player} on ${paidDate.format(new Date(entry.paidAt))}`;
}

function EntryRow({
  entry,
  users,
  pending,
  onVoid,
}: {
  entry: PaymentEntry;
  users: Map<number, Member>;
  pending: boolean;
  onVoid: (entry: PaymentEntry) => void;
}) {
  const voided = entry.status === "voided";
  const struck = voided ? "ledger-voided" : undefined;
  return (
    <tr>
      <td className={struck}>{paidDate.format(new Date(entry.paidAt))}</td>
      <th scope="row" className={struck}>
        {entry.userId === null
          ? "Unmatched"
          : memberName(users.get(entry.userId))}
      </th>
      <td className={struck}>{directionLabels[entry.direction]}</td>
      <td className={struck}>{usd(entry.amountCents)}</td>
      <td className={struck}>{sourceLabels[entry.source]}</td>
      <td className={`min-w-40 whitespace-normal ${struck ?? ""}`}>
        {entry.note ?? ""}
      </td>
      <td>
        <span
          className={entry.status === "approved" ? "badge success" : "badge"}
        >
          {statusLabels[entry.status]}
        </span>
      </td>
      <td>
        {entry.status === "approved" && (
          <button
            className="button secondary"
            disabled={pending}
            onClick={() => {
              onVoid(entry);
            }}
          >
            Void{" "}
            <span className="sr-only">{entryDescription(entry, users)}</span>
          </button>
        )}
      </td>
    </tr>
  );
}

function VoidConfirmation({
  description,
  pending,
  onConfirm,
  onKeep,
}: {
  description: string;
  pending: boolean;
  onConfirm: () => void;
  onKeep: () => void;
}) {
  const confirm = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    confirm.current?.focus();
  }, [description]);
  return (
    <div role="alert" className="alert warning mb-3">
      <p>
        Void {description}? It stops counting toward balances but stays in the
        history.
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          ref={confirm}
          className="button danger"
          disabled={pending}
          onClick={onConfirm}
        >
          Confirm void
        </button>
        <button className="button secondary" onClick={onKeep}>
          Keep entry
        </button>
      </div>
    </div>
  );
}

function EntryHistory({
  data,
  pending,
  onVoid,
}: {
  data: PaymentsData;
  pending: boolean;
  onVoid: (id: number) => Promise<boolean>;
}) {
  const [confirming, setConfirming] = useState<PaymentEntry | null>(null);
  const users = new Map(data.users.map((member) => [member.id, member]));
  if (!data.entries.length) {
    return (
      <p className="muted">
        No payments recorded for the {data.season} season yet.
      </p>
    );
  }
  return (
    <>
      {confirming && (
        <VoidConfirmation
          description={entryDescription(confirming, users)}
          pending={pending}
          onConfirm={() => {
            void onVoid(confirming.id).then((done) => {
              if (done) {
                setConfirming(null);
              }
            });
          }}
          onKeep={() => {
            setConfirming(null);
          }}
        />
      )}
      <div
        className="table-scroll"
        tabIndex={0}
        role="region"
        aria-label="Payment history"
      >
        <table className="standings-table season-table">
          <caption className="sr-only">
            {data.season} season payment history
          </caption>
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Player</th>
              <th scope="col">Direction</th>
              <th scope="col">Amount</th>
              <th scope="col">Source</th>
              <th scope="col">Note</th>
              <th scope="col">Status</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {data.entries.map((entry) => (
              <EntryRow
                key={entry.id}
                entry={entry}
                users={users}
                pending={pending}
                onVoid={setConfirming}
              />
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function PaymentsView({
  data,
  actions,
}: {
  data: PaymentsData;
  actions: ReturnType<typeof usePaymentActions>;
}) {
  return (
    <div className="space-y-6">
      <PaymentSummary summary={data.summary} />
      <section className="space-y-3" aria-labelledby="payment-balances">
        <div className="page-toolbar justify-between">
          <h2 id="payment-balances" className="font-semibold">
            Balances
          </h2>
          <BankerPicker
            data={data}
            pending={actions.banker.pending}
            error={actions.banker.error}
            onSave={(userId) => {
              void actions.saveBanker(data.season, userId);
            }}
          />
        </div>
        <FormError error={actions.banker.error} />
        <PlayerBalances data={data} />
      </section>
      <EntryForm
        data={data}
        pending={actions.entry.pending}
        error={actions.entry.error}
        onSubmit={actions.addEntry}
      />
      <section className="space-y-3" aria-labelledby="payment-history">
        <h2 id="payment-history" className="font-semibold">
          Payment history
        </h2>
        <ErrorNotice error={actions.voiding.error} />
        <EntryHistory
          data={data}
          pending={actions.voiding.pending}
          onVoid={actions.voidEntry}
        />
      </section>
    </div>
  );
}

function usePaymentActions(reload: () => void) {
  const entry = useMutation();
  const voiding = useMutation();
  const banker = useMutation();
  const [notice, setNotice] = useState<string | null>(null);
  async function addEntry(input: ManualPaymentInput) {
    setNotice(null);
    const result = await entry.mutate<PaymentsData>(
      "/api/admin/payments",
      "POST",
      input,
    );
    if (!result?.ok) {
      return false;
    }
    setNotice(
      `Recorded ${usd(input.amountCents)} ${input.direction === "in" ? "received" : "paid out"}.`,
    );
    reload();
    return true;
  }
  async function voidEntry(id: number) {
    setNotice(null);
    const result = await voiding.mutate<PaymentsData>(
      `/api/admin/payments/${id}/void`,
      "POST",
    );
    if (!result?.ok) {
      return false;
    }
    setNotice("Payment voided.");
    reload();
    return true;
  }
  async function saveBanker(season: number, userId: number | null) {
    setNotice(null);
    const result = await banker.mutate<PaymentsData>(
      `/api/admin/payments/banker?${new URLSearchParams({ season: String(season) })}`,
      "PUT",
      { userId },
    );
    if (result?.ok) {
      setNotice(userId === null ? "Banker cleared." : "Banker saved.");
      reload();
    }
  }
  return { entry, voiding, banker, notice, addEntry, voidEntry, saveBanker };
}

export function PaymentsPage() {
  const [params] = useSearchParams();
  const season = params.get("season");
  // Retained data keeps the form and focus in place while a write reloads.
  const resource = useResource<PaymentsData>(
    `/api/admin/payments${season ? `?${new URLSearchParams({ season })}` : ""}`,
    { retainDataOnReload: true },
  );
  const actions = usePaymentActions(resource.reload);
  return (
    <>
      <PageHeading
        title="Payments"
        subtitle="Money collected and paid out, and who still owes what."
        season={resource.data?.season}
      />
      <div className="page-toolbar">
        <SeasonPicker season={resource.data?.season} />
      </div>
      <p className="muted mb-5">
        Balances count approved entries against entry fees and winnings. Owes
        means the player owes the banker; You owe means the banker owes the
        player.
      </p>
      {actions.notice && (
        <p role="status" className="alert success mb-4">
          {actions.notice}
        </p>
      )}
      <ResourceView resource={resource}>
        {(data) => <PaymentsView data={data} actions={actions} />}
      </ResourceView>
    </>
  );
}
