import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test, expect } from "./fixtures";

test("anonymous winner receipts preserve the original Unicode bytes for independent verification", async ({
  page,
  rehearsal,
}) => {
  const original = await rehearsal.db
    .prepare("SELECT summary,verification_hash FROM hash_receipts WHERE id=?")
    .bind("00000000-0000-4000-8000-000000000101")
    .first<{ summary: string; verification_hash: string }>();
  assert(original);
  await page.goto(rehearsal.links.receipt);
  await expect(
    page.getByRole("heading", { name: "Winner receipt", exact: true }),
  ).toBeVisible();
  await expect(page.locator("pre")).toHaveText(original.summary);
  await expect(
    page.getByRole("link", {
      name: "Original hash message on Discord",
      exact: false,
    }),
  ).toHaveAttribute(
    "href",
    "https://discord.com/channels/900000000000000001/900000000000000999/900000000000000001",
  );

  const downloading = page.waitForEvent("download");
  await page
    .getByRole("link", { name: "Download receipt.txt", exact: true })
    .click();
  const download = await downloading;
  const path = await download.path();
  assert(path);
  const bytes = await readFile(path);
  expect(bytes.toString("utf8")).toBe(original.summary);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    original.verification_hash,
  );

  const link = await page
    .getByRole("link", { name: "Open SHA-256 in CyberChef", exact: false })
    .getAttribute("href");
  assert(link);
  const target = new URL(link);
  expect(target.origin).toBe("https://gchq.github.io");
  expect(target.search).toBe("");
  const parameters = new URLSearchParams(target.hash.slice(1));
  expect(parameters.get("recipe")).toBe("SHA2('256',64,160)");
  const input = parameters.get("input");
  assert(input);
  expect(Buffer.from(input, "base64")).toEqual(bytes);

  await page.goto(rehearsal.links.pendingReceipt);
  await expect(
    page.getByRole("heading", { name: "Receipt pending", exact: true }),
  ).toBeVisible();
  await expect(page.locator("pre")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Copy receipt", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Download receipt.txt", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Open SHA-256 in CyberChef", exact: false }),
  ).toHaveCount(0);
});
