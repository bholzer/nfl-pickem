import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import type { PublicReceipt } from "../shared/contracts";
import { useResource } from "./api";
import { ErrorNotice, PageHeading, ResourceView } from "./ui";

function receiptBase64(summary: string) {
  let binary = "";
  for (const byte of new TextEncoder().encode(summary)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function ReceiptBody({ summary }: { summary: string }) {
  const input = useMemo(() => receiptBase64(summary), [summary]);
  const [copying, setCopying] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<Error>();
  // CyberChef's App.loadURIParams and Utils.parseRecipeConfig accept this
  // single SHA2 operation, with UTF-8 input and LF line endings made explicit.
  const cyberChefUrl = `https://gchq.github.io/CyberChef/#recipe=SHA2('256',64,160)&input=${encodeURIComponent(input)}&ienc=65001&ieol=LF`;
  async function copyReceipt() {
    setCopying(true);
    setCopied(false);
    setCopyError(undefined);
    try {
      await navigator.clipboard.writeText(summary);
      setCopied(true);
    } catch {
      setCopyError(
        new Error("Could not copy the receipt. Download receipt.txt instead."),
      );
    } finally {
      setCopying(false);
    }
  }
  return (
    <section className="space-y-4" aria-labelledby="receipt-text-heading">
      <h2 id="receipt-text-heading" className="text-lg font-semibold">
        Original receipt
      </h2>
      <pre className="panel min-w-0 font-mono text-sm leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap">
        {summary}
      </pre>
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          className="button secondary"
          disabled={copying}
          onClick={() => void copyReceipt()}
        >
          {copying ? "Copying…" : "Copy receipt"}
        </button>
        <a
          className="button secondary"
          href={`data:text/plain;charset=utf-8;base64,${input}`}
          download="receipt.txt"
        >
          Download receipt.txt
        </a>
      </div>
      <p className="muted" role="status">
        {copied
          ? "Receipt copied."
          : "Download preserves the original UTF-8 bytes, including line endings."}
      </p>
      <ErrorNotice error={copyError} />
      <div className="space-y-3 border-t border-[var(--line)] pt-6">
        <h2 className="text-lg font-semibold">Compare independently</h2>
        <p>
          Open CyberChef with the original receipt as input and one SHA2
          operation set to 256 bits (SHA-256, 64 rounds). Compare its full
          64-character output with the hash in the original Discord message, not
          just the hash displayed on this page.
        </p>
        <a
          className="button primary"
          href={cyberChefUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open SHA-256 in CyberChef
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
        <p className="muted">
          CyberChef is an independent external tool. The receipt is included in
          the link fragment. Keep its input unchanged; adding a newline or
          changing whitespace changes the hash.
        </p>
      </div>
    </section>
  );
}

function ReceiptView({
  receipt,
  refresh,
}: {
  receipt: PublicReceipt;
  refresh: () => void;
}) {
  return (
    <div className="mx-auto max-w-[760px] min-w-0 space-y-6 [overflow-wrap:anywhere]">
      <PageHeading
        title="Winner receipt"
        season={receipt.season}
        week={receipt.week}
        subtitle={receipt.username ?? "Pool member"}
      />
      <section className="space-y-4" aria-labelledby="published-hash-heading">
        <h2 id="published-hash-heading" className="text-lg font-semibold">
          Published SHA-256
        </h2>
        <p className="font-mono text-sm leading-relaxed break-all">
          {receipt.verificationHash}
        </p>
        <a
          className="button secondary"
          href={receipt.originalMessageUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          Original hash message on Discord
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
        <p className="muted [overflow-wrap:anywhere]">
          Receipt snapshot:{" "}
          <time dateTime={receipt.snapshotAt}>{receipt.snapshotAt}</time>. This
          timestamp records when the receipt was frozen; it is not proof of
          submission before kickoff.
        </p>
      </section>
      {receipt.status === "pending" ? (
        <section
          className="panel space-y-4"
          aria-labelledby="receipt-pending-heading"
        >
          <h2 id="receipt-pending-heading" className="text-lg font-semibold">
            Receipt pending
          </h2>
          <p role="status">
            The original receipt, including picks and tiebreaker, becomes
            available after all games in this week are final. It is not shared
            while games remain unfinished.
          </p>
          <button type="button" className="button secondary" onClick={refresh}>
            Refresh receipt
          </button>
        </section>
      ) : (
        <ReceiptBody summary={receipt.summary} />
      )}
    </div>
  );
}

export function ReceiptPage() {
  const { id = "" } = useParams();
  const resource = useResource<PublicReceipt>(
    `/api/receipts/${encodeURIComponent(id)}`,
  );
  return (
    <ResourceView resource={resource}>
      {(receipt) => (
        <ReceiptView
          key={receipt.id}
          receipt={receipt}
          refresh={resource.reload}
        />
      )}
    </ResourceView>
  );
}
