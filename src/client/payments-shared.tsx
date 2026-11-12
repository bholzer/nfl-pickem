import { useState, type ReactNode } from "react";
import type {
  PaymentDirection,
  PaymentEntry,
  PaymentSource,
  PaymentsData,
} from "../shared/contracts";
import { errorMessage, RequestError, type useMutation } from "./api";
import { usd } from "./ui";

export type Member = PaymentsData["users"][number];
type Mutation = ReturnType<typeof useMutation>;

export const paidDate = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  month: "short",
  day: "numeric",
  year: "numeric",
});

export const directionLabels: Record<PaymentDirection, string> = {
  in: "Received from player",
  out: "Paid to player",
};

export const sourceLabels: Record<PaymentSource, string> = {
  manual: "Manual",
  venmo_email: "Venmo email",
  venmo_csv: "Venmo CSV",
  carryover: "Carryover",
};

export function memberName(member: Pick<Member, "username"> | undefined) {
  return member?.username ?? "Pool member";
}

export function memberOptions(users: Member[]) {
  return users.map((member) => ({
    value: String(member.id),
    label: memberName(member),
  }));
}

export function seasonQuery(season: number) {
  return `?${new URLSearchParams({ season: String(season) })}`;
}

/** Reads the amount, direction and date the way a person would say them. */
export function describeEntry(entry: PaymentEntry, who: string) {
  const verb = entry.direction === "in" ? "received from" : "paid to";
  return `${usd(entry.amountCents)} ${verb} ${who} on ${paidDate.format(new Date(entry.paidAt))}`;
}

export function fieldMessage(error: unknown, field: string) {
  return error instanceof RequestError ? error.fields[field] : undefined;
}

export function FieldMessage({
  id,
  message,
}: {
  id: string;
  message?: string;
}) {
  return message ? (
    <p id={id} className="field-error">
      {message}
    </p>
  ) : null;
}

// Field messages sit beside their controls; this carries the summary.
export function FormError({ error }: { error: unknown }) {
  return error ? (
    <p role="alert" className="alert error mb-4">
      {errorMessage(error)}
    </p>
  ) : null;
}

export function Field({
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

export function invalidProps(id: string, message: string | undefined) {
  return {
    "aria-invalid": message ? true : undefined,
    "aria-describedby": message ? `${id}-error` : undefined,
  };
}

/**
 * Sends one write, then reloads the page data. The page-level notice is
 * replaced by `notice`, or cleared when a section reports its own outcome.
 */
export function usePaymentWriter(reload: () => void) {
  const [notice, setNotice] = useState<string | null>(null);
  async function write<T>(
    mutation: Mutation,
    request: { path: string; method: string; body?: unknown },
    message?: (data: T) => string,
  ): Promise<T | null> {
    setNotice(null);
    const result = await mutation.mutate<T>(
      request.path,
      request.method,
      request.body,
    );
    if (!result?.ok) {
      return null;
    }
    setNotice(message ? message(result.data) : null);
    reload();
    return result.data;
  }
  return { notice, write };
}

export type PaymentWriter = ReturnType<typeof usePaymentWriter>["write"];
