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

function Layout() {
  const session = useSession();
  const logout = useMutation();
  const navigate = useNavigate();
  const location = useLocation();
  const main = useRef<HTMLElement>(null);
  useEffect(() => {
    main.current?.focus();
  }, [location.pathname, location.search]);
  const query = periodQuery(new URLSearchParams(location.search));
  async function signOut() {
    if ((await logout.mutate<undefined>("/logout", "DELETE"))?.ok) {
      session.expire();
      await navigate("/sign_in", { replace: true });
    }
  }
  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="border-b border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-3 py-3 sm:px-4">
          <Link to={`/${query}`} className="text-xl font-bold">
            NFL Pick’em
          </Link>
          <ThemePicker />
          {session.user && (
            <>
              <nav
                aria-label="Main navigation"
                className="flex w-full flex-wrap gap-1"
              >
                <NavLink className="nav-link" to={`/standings${query}`}>
                  Standings
                </NavLink>
                <NavLink className="nav-link" to={`/submissions/new${query}`}>
                  Make picks
                </NavLink>
                <NavLink className="nav-link" end to={`/submissions${query}`}>
                  My submissions
                </NavLink>
                {session.user.admin && (
                  <>
                    <NavLink
                      className="nav-link"
                      to={`/admin/submissions${query}`}
                    >
                      All submissions
                    </NavLink>
                    <NavLink className="nav-link" to={`/admin/jobs${query}`}>
                      Jobs
                    </NavLink>
                  </>
                )}
              </nav>
              <div className="flex w-full items-center justify-between gap-3 text-sm">
                <span>
                  {session.user.username ?? "Pool member"}
                  {session.user.admin && (
                    <span className="badge ml-2">Admin</span>
                  )}
                </span>
                <button
                  className="button secondary"
                  disabled={logout.pending}
                  onClick={() => {
                    void signOut();
                  }}
                >
                  Sign out
                </button>
              </div>
              <ErrorNotice error={logout.error} />
            </>
          )}
        </div>
      </header>
      <main
        id="main-content"
        tabIndex={-1}
        ref={main}
        className="mx-auto max-w-6xl px-3 py-5 outline-none sm:px-4 sm:py-7"
      >
        <SessionContent />
      </main>
    </>
  );
}
function SessionContent() {
  const session = useSession();
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
function SignIn() {
  const { user } = useSession();
  const [params] = useSearchParams();
  const requested =
    params.get("return_to") ?? `/standings${periodQuery(params)}`;
  const returnTo =
    requested.startsWith("/") &&
    !requested.startsWith("//") &&
    !requested.includes("\\") &&
    !/^\/(sign_in|auth)(?:[/?]|$)/.test(requested)
      ? requested
      : "/standings";
  if (user) {
    return <Navigate to={returnTo} replace />;
  }
  return (
    <section className="panel mx-auto max-w-md space-y-5 sm:mt-12">
      <h1 className="text-3xl font-bold">Corn Town NFL Pick’em</h1>
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
          <Route index element={<SignIn />} />
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
