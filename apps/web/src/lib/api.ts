/**
 * API client.
 *
 * Handles the two things every call needs and nobody should re-implement: attaching
 * the bearer token plus the active shop header, and transparently refreshing an
 * expired access token. Concurrent 401s share a single refresh — otherwise a dashboard
 * firing eight parallel widget requests would trigger eight refreshes and, because
 * refresh tokens rotate, seven of them would be rejected as replays and log the user out.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

const ACCESS_TOKEN_KEY = 'intoto.accessToken';
const REFRESH_TOKEN_KEY = 'intoto.refreshToken';
const ACTIVE_SHOP_KEY = 'intoto.activeShopId';

export interface ApiErrorPayload {
  statusCode: number;
  message: string;
  error?: string;
  details?: Record<string, string[]>;
  correlationId?: string;
}

export class ApiError extends Error {
  readonly statusCode: number;
  readonly details?: Record<string, string[]>;
  readonly correlationId?: string;

  constructor(payload: ApiErrorPayload) {
    super(payload.message);
    this.name = 'ApiError';
    this.statusCode = payload.statusCode;
    this.details = payload.details;
    this.correlationId = payload.correlationId;
  }
}

export const tokenStore = {
  get access(): string | null {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem(ACCESS_TOKEN_KEY);
  },
  get refresh(): string | null {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem(REFRESH_TOKEN_KEY);
  },
  get activeShopId(): string | null {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem(ACTIVE_SHOP_KEY);
  },
  set(access: string, refresh: string): void {
    window.localStorage.setItem(ACCESS_TOKEN_KEY, access);
    window.localStorage.setItem(REFRESH_TOKEN_KEY, refresh);
  },
  setActiveShop(shopId: string | null): void {
    if (shopId) window.localStorage.setItem(ACTIVE_SHOP_KEY, shopId);
    else window.localStorage.removeItem(ACTIVE_SHOP_KEY);
  },
  clear(): void {
    window.localStorage.removeItem(ACCESS_TOKEN_KEY);
    window.localStorage.removeItem(REFRESH_TOKEN_KEY);
    window.localStorage.removeItem(ACTIVE_SHOP_KEY);
  },
};

/** In-flight refresh, shared by every request that hits a 401 at the same moment. */
let refreshInFlight: Promise<boolean> | null = null;

async function refreshAccessToken(): Promise<boolean> {
  refreshInFlight ??= (async () => {
    try {
      const refreshToken = tokenStore.refresh;
      if (!refreshToken) return false;

      const response = await fetch(`${API_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!response.ok) return false;

      const data = (await response.json()) as { accessToken: string; refreshToken: string };
      tokenStore.set(data.accessToken, data.refreshToken);
      return true;
    } catch {
      return false;
    } finally {
      // Cleared on the next tick so callers awaiting this promise all observe the
      // same result before a fresh attempt can start.
      setTimeout(() => {
        refreshInFlight = null;
      }, 0);
    }
  })();

  return refreshInFlight;
}

export interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** Skip the bearer token (login, refresh) */
  anonymous?: boolean;
  /** Return the raw Response — for file downloads */
  raw?: boolean;
  query?: Record<string, string | number | boolean | undefined | null>;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, anonymous, raw, query, headers, ...rest } = options;

  const url = new URL(`${API_URL}${path.startsWith('/') ? path : `/${path}`}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const build = (): RequestInit => {
    const requestHeaders = new Headers(headers);
    if (body !== undefined && !(body instanceof FormData)) {
      requestHeaders.set('Content-Type', 'application/json');
    }
    if (!anonymous) {
      const token = tokenStore.access;
      if (token) requestHeaders.set('Authorization', `Bearer ${token}`);
      const shopId = tokenStore.activeShopId;
      if (shopId) requestHeaders.set('x-shop-id', shopId);
    }
    return {
      ...rest,
      headers: requestHeaders,
      body: body instanceof FormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
    };
  };

  let response = await fetch(url, build());

  if (response.status === 401 && !anonymous) {
    if (await refreshAccessToken()) {
      response = await fetch(url, build());
    } else {
      tokenStore.clear();
      if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
        window.location.href = '/login';
      }
      throw new ApiError({ statusCode: 401, message: 'Your session has expired' });
    }
  }

  if (raw) {
    if (!response.ok) throw await toApiError(response);
    return response as unknown as T;
  }

  if (response.status === 204) return undefined as T;
  if (!response.ok) throw await toApiError(response);

  return (await response.json()) as T;
}

async function toApiError(response: Response): Promise<ApiError> {
  try {
    const payload = (await response.json()) as ApiErrorPayload;
    return new ApiError({ ...payload, statusCode: payload.statusCode ?? response.status });
  } catch {
    return new ApiError({
      statusCode: response.status,
      message: response.statusText || 'Request failed',
    });
  }
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) =>
    request<T>(path, { ...options, method: 'GET' }),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: 'POST', body }),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: 'PATCH', body }),
  put: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: 'PUT', body }),
  delete: <T>(path: string, options?: RequestOptions) =>
    request<T>(path, { ...options, method: 'DELETE' }),

  /** Download an export and hand the browser a save dialog. */
  async download(path: string, filename: string, options?: RequestOptions): Promise<void> {
    const response = await request<Response>(path, { ...options, method: 'GET', raw: true });
    const blob = await response.blob();

    // Prefer the server's filename — it carries the report period and shop.
    const disposition = response.headers.get('content-disposition');
    const match = disposition ? /filename="?([^"]+)"?/.exec(disposition) : null;

    const objectUrl = window.URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = match?.[1] ?? filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.URL.revokeObjectURL(objectUrl);
  },
};
