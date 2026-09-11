import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useLocation } from "react-router-dom";
import type { ApiError, SessionData } from "../shared/contracts";

export class RequestError extends Error {
  constructor(
    public status: number,
    message: string,
    public fields: Record<string, string> = {},
    public body?: ApiError,
  ) {
    super(message);
    this.name = "RequestError";
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  csrfToken?: string | null,
): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  if (options.body) {
    headers.set("Content-Type", "application/json");
  }
  if (csrfToken) {
    headers.set("X-CSRF-Token", csrfToken);
  }
  const response = await fetch(new URL(path, window.location.origin), {
    ...options,
    headers,
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiError | null;
    throw new RequestError(
      response.status,
      body?.error || `Request failed (${response.status}). Please try again.`,
      body?.fields,
      body ?? undefined,
    );
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return response.json() as Promise<T>;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
}

interface SessionContextValue extends SessionData {
  loading: boolean;
  error: unknown;
  reload: () => void;
  expire: () => void;
}
const SessionContext = createContext<SessionContextValue | null>(null);
export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionData>({
    user: null,
    csrfToken: null,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [version, setVersion] = useState(0);
  const expire = useCallback(() => {
    setSession({ user: null, csrfToken: null });
  }, []);
  const reload = useCallback(() => {
    setVersion((value) => value + 1);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    request<SessionData>("/api/session", { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) {
          setSession(data);
        }
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(reason);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });
    return () => {
      controller.abort();
    };
  }, [version]);
  return (
    <SessionContext.Provider
      value={{ ...session, loading, error, reload, expire }}
    >
      {children}
    </SessionContext.Provider>
  );
}
export function useSession() {
  const context = useContext(SessionContext);
  if (!context) {
    throw new Error("SessionProvider is required");
  }
  return context;
}

interface ResourceState<T> {
  data?: T;
  error?: unknown;
  loading: boolean;
}
export function useResource<T>(path: string | null): ResourceState<T> & {
  reload: () => void;
} {
  const { expire } = useSession();
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<
    ResourceState<T> & {
      path: string | null;
    }
  >({ path, loading: true });
  const reload = useCallback(() => {
    setVersion((value) => value + 1);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setState({ path, loading: true });
    if (path) {
      request<T>(path, { signal: controller.signal })
        .then((data) => {
          if (!controller.signal.aborted) {
            setState({ path, data, loading: false });
          }
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) {
            return;
          }
          if (error instanceof RequestError && error.status === 401) {
            expire();
          }
          setState({ path, error, loading: false });
        });
    }
    return () => {
      controller.abort();
    };
  }, [path, version, expire]);
  return { ...(state.path === path ? state : { loading: true }), reload };
}

type MutationResult<T> =
  { ok: true; data: T } | { ok: false; error: unknown } | undefined;

// Navigation aborts writes locally too: an old response must never redirect a new page.
export function useMutation() {
  const { csrfToken, expire } = useSession();
  const location = useLocation();
  const controller = useRef<AbortController | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    setError(null);
    setPending(false);
    return () => {
      controller.current?.abort();
    };
  }, [location.key]);
  async function mutate<T>(
    path: string,
    method: string,
    body?: unknown,
  ): Promise<MutationResult<T>> {
    controller.current?.abort();
    const active = new AbortController();
    controller.current = active;
    setPending(true);
    setError(null);
    try {
      const result = await request<T>(
        path,
        {
          method,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: active.signal,
        },
        csrfToken,
      );
      if (!active.signal.aborted) {
        return { ok: true, data: result };
      }
    } catch (reason) {
      if (!active.signal.aborted) {
        if (reason instanceof RequestError && reason.status === 401) {
          expire();
        }
        setError(reason);
        return { ok: false, error: reason };
      }
    } finally {
      if (!active.signal.aborted) {
        setPending(false);
      }
    }
    return undefined;
  }
  return { mutate, pending, error };
}
