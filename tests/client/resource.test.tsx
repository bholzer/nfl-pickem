import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { delay, http, HttpResponse } from "msw";
import { beforeEach, expect, it } from "vitest";
import { SessionProvider, useResource } from "../../src/client/api";
import { network } from "../setup-network";

function BoardReader() {
  const [path, setPath] = useState("/api/board/current");
  const resource = useResource<{ label: string }>(path, {
    retainDataOnReload: true,
  });
  return (
    <>
      {resource.loading && <p role="status">Loading board</p>}
      {resource.data && <p>{resource.data.label}</p>}
      {resource.error !== undefined && <p role="alert">Unable to read board</p>}
      <button type="button" onClick={resource.reload}>
        Refresh
      </button>
      <button
        type="button"
        onClick={() => {
          setPath("/api/board/archive");
        }}
      >
        Open archive
      </button>
    </>
  );
}

beforeEach(() => {
  network.use(
    http.get("http://localhost/api/session", () =>
      HttpResponse.json({ user: null, csrfToken: null }),
    ),
    http.get("http://localhost/api/board/current", () =>
      HttpResponse.json({ label: "Current private picks" }),
    ),
  );
  render(
    <SessionProvider>
      <BoardReader />
    </SessionProvider>,
  );
});

it("keeps a failed refresh readable but never shows it as a different board", async () => {
  await screen.findByText("Current private picks");
  network.use(
    http.get("http://localhost/api/board/current", () =>
      HttpResponse.json({ error: "Scoreboard unavailable" }, { status: 502 }),
    ),
    http.get("http://localhost/api/board/archive", async () => {
      await delay(100);
      return HttpResponse.json({ label: "Archived private picks" });
    }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(await screen.findByRole("alert")).toBeVisible();
  expect(screen.getByText("Current private picks")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Open archive" }));
  expect(screen.queryByText("Current private picks")).not.toBeInTheDocument();
  expect(await screen.findByText("Archived private picks")).toBeVisible();
});

it("discards retained private data when access is revoked", async () => {
  await screen.findByText("Current private picks");
  network.use(
    http.get("http://localhost/api/board/current", () =>
      HttpResponse.json({ error: "Access revoked" }, { status: 403 }),
    ),
  );
  await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(await screen.findByRole("alert")).toBeVisible();
  expect(screen.queryByText("Current private picks")).not.toBeInTheDocument();
});
