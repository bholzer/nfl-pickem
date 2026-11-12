import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type {
  ManualPaymentInput,
  PaymentDirection,
  PaymentEntry,
  PaymentPlayerBalance,
  PaymentPoolSummary,
  PaymentStatus,
  PaymentsData,
} from "../shared/contracts";
import { useMutation, useResource } from "./api";
import { EmailFailures, ReviewQueue } from "./payments-review";
import {
  describeEntry,
  directionLabels,
  Field,
  FieldMessage,
  fieldMessage,
  FormError,
  invalidProps,
  memberName,
  memberOptions,
  paidDate,
  seasonQuery,
  sourceLabels,
  usePaymentWriter,
  type Member,
  type PaymentWriter,
} from "./payments-shared";
import {
  ImportStatement,
  KeywordsForm,
  VenmoAccounts,
  venmoLink,
  venmoNote,
} from "./payments-venmo";
import {
  ErrorNotice,
  OptionPicker,
  PageHeading,
  ResourceView,
  SeasonPicker,
  usd,
} from "./ui";

// en-CA formats as YYYY-MM-DD, the value a date input expects.
const inputDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Chicago",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const statusLabels: Record<PaymentStatus, string> = {
  approved: "Approved",
  pending: "Pending review",
  ignored: "Ignored",
  voided: "Voided",
};

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

/** Request what a player owes, or pay what the banker owes; Venmo sends nothing until confirmed there. */
function linkUsername(
  player: PaymentPlayerBalance,
  usernames: Map<number, string | null>,
) {
  if (player.banker || player.balanceCents === 0) {
    return null;
  }
  return usernames.get(player.user.id) ?? null;
}

function BalanceLink({
  player,
  username,
  note,
}: {
  player: PaymentPlayerBalance;
  username: string | null;
  note: string;
}) {
  if (!username) {
    return null;
  }
  const owes = player.balanceCents < 0;
  const amount = usd(Math.abs(player.balanceCents));
  return (
    <a
      className="text-link"
      href={venmoLink({
        txn: owes ? "charge" : "pay",
        username,
        amountCents: player.balanceCents,
        note,
      })}
      target="_blank"
      rel="noopener noreferrer"
    >
      {owes ? `Request ${amount}` : `Pay ${amount}`}{" "}
      <span className="sr-only">
        {owes ? "from" : "to"} {memberName(player.user)} on Venmo (opens in a
        new tab)
      </span>
    </a>
  );
}

function PlayerRow({
  player,
  link,
}: {
  player: PaymentPlayerBalance;
  /** Absent when no row in the table has a Venmo link. */
  link?: { username: string | null; note: string };
}) {
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
      {link && (
        <td>
          <BalanceLink player={player} {...link} />
        </td>
      )}
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
  const usernames = new Map(
    data.venmoAccounts.map((account) => [account.userId, account.username]),
  );
  const note = venmoNote(data.season, data.keywords);
  const players = sortPlayers(data.players);
  // The Venmo column appears only when some player can be sent a link.
  const linked = players.some((player) => linkUsername(player, usernames));
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
            {linked && <th scope="col">Venmo</th>}
          </tr>
        </thead>
        <tbody>
          {players.map((player) => (
            <PlayerRow
              key={player.user.id}
              player={player}
              link={
                linked
                  ? { username: linkUsername(player, usernames), note }
                  : undefined
              }
            />
          ))}
        </tbody>
      </table>
    </div>
  );
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
  return describeEntry(entry, player);
}

function rowClass(entry: PaymentEntry) {
  if (entry.status === "voided") {
    return "ledger-voided";
  }
  return entry.status === "ignored" ? "ledger-ignored" : undefined;
}

// Only Venmo imports can return to the queue; manual entries are corrected by void.
function reopenable(entry: PaymentEntry) {
  return (
    (entry.source === "venmo_csv" || entry.source === "venmo_email") &&
    (entry.status === "approved" || entry.status === "ignored")
  );
}

function EntryActions({
  entry,
  description,
  pending,
  onVoid,
  onReopen,
}: {
  entry: PaymentEntry;
  description: string;
  pending: boolean;
  onVoid: (entry: PaymentEntry) => void;
  onReopen: (entry: PaymentEntry) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {reopenable(entry) && (
        <button
          className="button secondary"
          disabled={pending}
          onClick={() => {
            onReopen(entry);
          }}
        >
          Reopen <span className="sr-only">{description}</span>
        </button>
      )}
      {entry.status === "approved" && (
        <button
          className="button secondary"
          disabled={pending}
          onClick={() => {
            onVoid(entry);
          }}
        >
          Void <span className="sr-only">{description}</span>
        </button>
      )}
    </div>
  );
}

function EntryRow({
  entry,
  users,
  pending,
  onVoid,
  onReopen,
}: {
  entry: PaymentEntry;
  users: Map<number, Member>;
  pending: boolean;
  onVoid: (entry: PaymentEntry) => void;
  onReopen: (entry: PaymentEntry) => void;
}) {
  const muted = rowClass(entry);
  return (
    <tr>
      <td className={muted}>{paidDate.format(new Date(entry.paidAt))}</td>
      <th scope="row" className={muted}>
        {entry.userId === null
          ? "Unmatched"
          : memberName(users.get(entry.userId))}
        {entry.venmoName && (
          <span className="block text-xs font-normal text-muted">
            Venmo: {entry.venmoName}
          </span>
        )}
      </th>
      <td className={muted}>{directionLabels[entry.direction]}</td>
      <td className={muted}>{usd(entry.amountCents)}</td>
      <td className={muted}>{sourceLabels[entry.source]}</td>
      <td className={`min-w-40 whitespace-normal ${muted ?? ""}`}>
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
        <EntryActions
          entry={entry}
          description={entryDescription(entry, users)}
          pending={pending}
          onVoid={onVoid}
          onReopen={onReopen}
        />
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
  onReopen,
}: {
  data: PaymentsData;
  pending: boolean;
  onVoid: (id: number) => Promise<boolean>;
  onReopen: (id: number) => void;
}) {
  const [confirming, setConfirming] = useState<PaymentEntry | null>(null);
  const users = new Map(data.users.map((member) => [member.id, member]));
  // Pending entries are decided in the review queue, not here.
  const entries = data.entries.filter((entry) => entry.status !== "pending");
  if (!entries.length) {
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
            {entries.map((entry) => (
              <EntryRow
                key={entry.id}
                entry={entry}
                users={users}
                pending={pending}
                onVoid={setConfirming}
                onReopen={(item) => {
                  setConfirming(null);
                  onReopen(item.id);
                }}
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
  write,
}: {
  data: PaymentsData;
  actions: ReturnType<typeof usePaymentActions>;
  write: PaymentWriter;
}) {
  return (
    <div className="space-y-6">
      <EmailFailures data={data} write={write} />
      <ReviewQueue data={data} write={write} />
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
        <ErrorNotice error={actions.history.error} />
        <EntryHistory
          data={data}
          pending={actions.history.pending}
          onVoid={actions.voidEntry}
          onReopen={(id) => {
            void actions.reopenEntry(id);
          }}
        />
      </section>
      <ImportStatement data={data} write={write} />
      <KeywordsForm data={data} write={write} />
      <VenmoAccounts data={data} write={write} />
    </div>
  );
}

function usePaymentActions(write: PaymentWriter) {
  const entry = useMutation();
  const history = useMutation();
  const banker = useMutation();
  async function addEntry(input: ManualPaymentInput) {
    const verb = input.direction === "in" ? "received" : "paid out";
    const result = await write(
      entry,
      { path: "/api/admin/payments", method: "POST", body: input },
      () => `Recorded ${usd(input.amountCents)} ${verb}.`,
    );
    return result !== null;
  }
  async function voidEntry(id: number) {
    const result = await write(
      history,
      { path: `/api/admin/payments/${id}/void`, method: "POST" },
      () => "Payment voided.",
    );
    return result !== null;
  }
  async function reopenEntry(id: number) {
    await write(
      history,
      { path: `/api/admin/payments/${id}/reopen`, method: "POST" },
      () => "Payment returned to review.",
    );
  }
  async function saveBanker(season: number, userId: number | null) {
    await write(
      banker,
      {
        path: `/api/admin/payments/banker${seasonQuery(season)}`,
        method: "PUT",
        body: { userId },
      },
      () => (userId === null ? "Banker cleared." : "Banker saved."),
    );
  }
  return {
    entry,
    history,
    banker,
    addEntry,
    voidEntry,
    reopenEntry,
    saveBanker,
  };
}

export function PaymentsPage() {
  const [params] = useSearchParams();
  const season = params.get("season");
  // Retained data keeps the form and focus in place while a write reloads.
  const resource = useResource<PaymentsData>(
    `/api/admin/payments${season ? `?${new URLSearchParams({ season })}` : ""}`,
    { retainDataOnReload: true },
  );
  const { notice, write } = usePaymentWriter(resource.reload);
  const actions = usePaymentActions(write);
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
      {notice && (
        <p role="status" className="alert success mb-4">
          {notice}
        </p>
      )}
      <ResourceView resource={resource}>
        {(data) => <PaymentsView data={data} actions={actions} write={write} />}
      </ResourceView>
    </>
  );
}
