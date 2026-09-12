import { useEffect, useRef } from "react";
import {
  Link,
  NavLink,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import { SessionProvider, useMutation, useSession } from "./api";
import { ErrorNotice, periodQuery, ThemePicker } from "./ui";
import {
  AdminSubmissions,
  HistoryPage,
  PicksPage,
  StandingsPage,
  SubmissionPage,
} from "./picks";
import { JobDetailPage, JobsPage } from "./jobs";
import { clearDraftsForUser, clearExpiredDrafts } from "./drafts";
import { DashboardPage } from "./dashboard";

function AccountMenu({ query }: { query: string }) {
  const session = useSession();
  const logout = useMutation();
  const navigate = useNavigate();
  const location = useLocation();
  const menu = useRef<HTMLDetailsElement>(null);
  const trigger = useRef<HTMLElement>(null);
  useEffect(() => {
    if (menu.current) {
      menu.current.open = false;
    }
  }, [location.pathname, location.search]);
  useEffect(() => {
    function closeOutside(event: Event) {
      const details = menu.current;
      if (!details?.open || !(event.target instanceof Node)) {
        return;
      }
      if (details.contains(event.target)) {
        return;
      }
      if (details.contains(document.activeElement)) {
        trigger.current?.focus();
      }
      details.open = false;
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape" || !menu.current?.open) {
        return;
      }
      event.preventDefault();
      trigger.current?.focus();
      menu.current.open = false;
    }
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("focusin", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("focusin", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);
  async function signOut() {
    const user = session.user;
    if (!user) {
      return;
    }
    if ((await logout.mutate<undefined>("/logout", "DELETE"))?.ok) {
      clearDraftsForUser(user.id);
      session.expire();
      await navigate("/sign_in", { replace: true });
    }
  }
  const username = session.user?.username ?? "Pool member";
  return (
    <details className="account-menu" ref={menu}>
      <summary className="account-trigger" ref={trigger}>
        <span className="account-avatar" aria-hidden="true">
          {username.slice(0, 1).toUpperCase()}
        </span>
        <span>Account</span>
      </summary>
      <div className="account-popover">
        <div className="account-identity">
          <strong>{username}</strong>
          {session.user?.admin && <span className="badge">Admin</span>}
        </div>
        <ThemePicker />
        {session.user?.admin && (
          <nav className="account-links" aria-label="Administration">
            <NavLink className="nav-link" to={`/admin/submissions${query}`}>
              All submissions
            </NavLink>
            <NavLink className="nav-link" to={`/admin/jobs${query}`}>
              Jobs
            </NavLink>
          </nav>
        )}
        <button
          className="button secondary w-full"
          disabled={logout.pending}
          onClick={() => {
            void signOut();
          }}
        >
          Sign out
        </button>
        <ErrorNotice error={logout.error} />
      </div>
    </details>
  );
}

function NavigationIcon({
  kind,
}: {
  kind: "home" | "picks" | "standings" | "history";
}) {
  const paths = {
    home: "m3 10 9-7 9 7v11h-6v-7H9v7H3z",
    picks: "m5 12 4 4L19 6",
    standings: "M5 20V10m7 10V4m7 16v-7",
    history: "M6 3h12v18H6zM9 8h6m-6 4h6m-6 4h4",
  };
  return (
    <svg
      className="nav-icon"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={paths[kind]} />
    </svg>
  );
}

function Layout() {
  const session = useSession();
  const location = useLocation();
  const main = useRef<HTMLElement>(null);
  useEffect(() => {
    main.current?.focus();
  }, [location.pathname, location.search]);
  const query = periodQuery(new URLSearchParams(location.search));
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="app-header">
        <div className="app-header-inner">
          <Link to="/" className="app-brand">
            <span className="brand-name">Corn Town</span>
            <span className="brand-caption">Weekly picks</span>
          </Link>
          {session.user ? <AccountMenu query={query} /> : <ThemePicker />}
          {session.user && (
            <nav aria-label="Main navigation" className="app-navigation">
              <NavLink className="nav-link" end to="/">
                <NavigationIcon kind="home" />
                <span>Home</span>
              </NavLink>
              <NavLink className="nav-link" end to={`/submissions/new${query}`}>
                <NavigationIcon kind="picks" />
                <span>Make picks</span>
              </NavLink>
              <NavLink className="nav-link" to={`/standings${query}`}>
                <NavigationIcon kind="standings" />
                <span>Standings</span>
              </NavLink>
              <NavLink
                className="nav-link"
                end
                to={`/submissions${query}`}
                aria-label="My submissions"
              >
                <NavigationIcon kind="history" />
                <span className="md:hidden">Submissions</span>
                <span className="hidden md:inline">My submissions</span>
              </NavLink>
            </nav>
          )}
        </div>
      </header>
      <main
        id="main-content"
        tabIndex={-1}
        ref={main}
        className="app-content outline-none"
      >
        <SessionContent />
      </main>
    </div>
  );
}
function SessionContent() {
  const session = useSession();
  useEffect(() => {
    clearExpiredDrafts();
    const timer = window.setInterval(clearExpiredDrafts, 60_000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);
  if (session.loading) {
    return <p role="status">Checking your session…</p>;
  }
  if (session.error) {
    return <ErrorNotice error={session.error} retry={session.reload} />;
  }
  return <Outlet />;
}
function Protected({ admin = false }: { admin?: boolean }) {
  const { user } = useSession();
  const location = useLocation();
  if (!user) {
    return (
      <Navigate
        replace
        to={`/sign_in?return_to=${encodeURIComponent(location.pathname + location.search)}`}
      />
    );
  }
  if (admin && !user.admin) {
    return (
      <section className="panel">
        <h1 className="text-2xl font-bold">Access denied</h1>
        <p className="mt-3">
          An administrator account is required for this page.
        </p>
        <Link
          className="button primary mt-4"
          to={`/standings${periodQuery(new URLSearchParams(location.search))}`}
        >
          View standings
        </Link>
      </section>
    );
  }
  return <Outlet />;
}
function signInDestination(params: URLSearchParams) {
  const requested = params.get("return_to") ?? `/${periodQuery(params)}`;
  return requested.startsWith("/") &&
    !requested.startsWith("//") &&
    !requested.includes("\\") &&
    !/^\/(sign_in|auth)(?:[/?]|$)/.test(requested)
    ? requested
    : "/";
}

function Home() {
  const { user } = useSession();
  const location = useLocation();
  const [params] = useSearchParams();
  if (!user) {
    return <SignIn />;
  }
  const destination = signInDestination(params);
  if (
    params.has("return_to") &&
    destination !== location.pathname + location.search
  ) {
    return <Navigate to={destination} replace />;
  }
  return <DashboardPage />;
}

function SignIn() {
  const { user } = useSession();
  const [params] = useSearchParams();
  const returnTo = signInDestination(params);
  if (user) {
    return <Navigate to={returnTo} replace />;
  }
  return (
    <section className="panel sign-in-panel space-y-6">
      <div>
        <p className="brand-caption">Weekly picks</p>
        <h1 className="mt-3">Corn Town</h1>
      </div>
      <p className="muted">
        Sign in to view standings and submit your picks. Use your pool’s Discord
        account or your personalized submission link.
      </p>
      {params.get("error") && (
        <p role="alert" className="alert error">
          Sign-in failed. Please try again or contact your pool administrator.
        </p>
      )}
      <a
        className="button primary w-full"
        href={`/auth/discord?return_to=${encodeURIComponent(returnTo)}`}
      >
        Sign in with Discord
      </a>
    </section>
  );
}
export function App() {
  return (
    <SessionProvider>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Home />} />
          <Route path="sign_in" element={<SignIn />} />
          <Route element={<Protected />}>
            <Route path="standings" element={<StandingsPage />} />
            <Route path="submissions" element={<HistoryPage />} />
            <Route path="submissions/new" element={<PicksPage />} />
            <Route path="submissions/:id" element={<SubmissionPage />} />
            <Route element={<Protected admin />}>
              <Route path="admin/submissions" element={<AdminSubmissions />} />
              <Route
                path="admin/submissions/:id"
                element={<SubmissionPage admin />}
              />
              <Route path="admin/jobs" element={<JobsPage />} />
              <Route path="admin/jobs/:id" element={<JobDetailPage />} />
            </Route>
          </Route>
          <Route
            path="*"
            element={
              <section className="panel">
                <h1 className="text-2xl font-bold">Page not found</h1>
                <Link className="button primary mt-4" to="/">
                  Return home
                </Link>
              </section>
            }
          />
        </Route>
      </Routes>
    </SessionProvider>
  );
}
