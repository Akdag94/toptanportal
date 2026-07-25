/**
 * ToptanPortal Web - API Istemcisi
 *
 * Sorumluluklar:
 *  * Erisim jetonunu bellekte tutar (localStorage'da SAKLANMAZ)
 *  * 401 alindiginda yenileme jetonu ile bir kez otomatik yeniler ve istegi
 *    tekrarlar; es zamanli isteklerde tek bir yenileme yapilir
 *  * Hatalari ApiError'a donusturur - arayuz hata KODUNA gore dallanir
 *
 * GUVENLIK NOTU: Yenileme jetonu localStorage'da tutulur. Bu, sayfa
 * yenilendiginde oturumun surmesini saglar ancak XSS durumunda jetonu acik
 * hale getirir. Uretimde tercih edilen model, jetonu httpOnly cerezde tutan
 * bir BFF (Next.js route handler) katmanidir; ag mimarisi netlestiginde bu
 * modul o katmana yonlendirilecek sekilde tasarlanmistir - cagiran kod degismez.
 */

import type {
  ApiErrorBody,
  ErrorCode,
  LoginResponse,
  SessionUser,
  TokenPair,
} from '@toptanportal/contracts';

import { getDeviceInfo } from './device';

const REFRESH_TOKEN_KEY = 'toptanportal.refreshToken';

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, '') ?? 'http://localhost:3001';

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: Record<string, string[]>;
  readonly requestId: string;

  constructor(body: ApiErrorBody) {
    super(body.message);
    this.name = 'ApiError';
    this.code = body.code;
    this.statusCode = body.statusCode;
    this.details = body.details;
    this.requestId = body.requestId;
  }
}

export class NetworkError extends Error {
  constructor() {
    super('Sunucuya ulaşılamadı. İnternet bağlantınızı kontrol edin.');
    this.name = 'NetworkError';
  }
}

let accessToken: string | null = null;
let refreshPromise: Promise<boolean> | null = null;
const sessionListeners = new Set<(user: SessionUser | null) => void>();

export function onSessionChange(listener: (user: SessionUser | null) => void): () => void {
  sessionListeners.add(listener);
  return () => sessionListeners.delete(listener);
}

function emitSessionChange(user: SessionUser | null): void {
  for (const listener of sessionListeners) listener(user);
}

export function setTokens(tokens: TokenPair): void {
  accessToken = tokens.accessToken;
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(REFRESH_TOKEN_KEY, tokens.refreshToken);
  }
}

export function clearTokens(): void {
  accessToken = null;
  if (typeof window !== 'undefined') {
    window.localStorage.removeItem(REFRESH_TOKEN_KEY);
  }
}

export function getRefreshToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(REFRESH_TOKEN_KEY);
}

export function hasStoredSession(): boolean {
  return getRefreshToken() !== null;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** true ise 401'de otomatik yenileme denenmez (yenileme cagrisinin kendisi). */
  skipRefresh?: boolean;
  headers?: Record<string, string>;
}

async function rawRequest<TResponse>(
  path: string,
  options: RequestOptions,
): Promise<TResponse> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...options.headers,
  };

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  let response: Response;

  try {
    response = await fetch(`${API_BASE_URL}/api/v1${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: 'no-store',
    });
  } catch {
    throw new NetworkError();
  }

  if (response.status === 204) {
    return undefined as TResponse;
  }

  const text = await response.text();
  let payload: unknown = null;

  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ApiError({
        statusCode: response.status,
        code: 'INTERNAL_ERROR',
        message: 'Sunucudan beklenmeyen bir yanıt alındı.',
        requestId: response.headers.get('X-Request-Id') ?? 'bilinmeyen',
        timestamp: new Date().toISOString(),
      });
    }
  }

  if (!response.ok) {
    throw new ApiError(payload as ApiErrorBody);
  }

  return payload as TResponse;
}

export async function request<TResponse>(
  path: string,
  options: RequestOptions = {},
): Promise<TResponse> {
  try {
    return await rawRequest<TResponse>(path, options);
  } catch (error) {
    const retryable =
      error instanceof ApiError &&
      error.statusCode === 401 &&
      !options.skipRefresh &&
      getRefreshToken() !== null;

    if (!retryable) throw error;

    const refreshed = await refreshSession();
    if (!refreshed) throw error;

    return rawRequest<TResponse>(path, options);
  }
}

/**
 * Oturumu yeniler. Es zamanli cagrilar tek bir yenileme isteginde birlesir;
 * aksi halde jeton rotasyonu yarisir ve yeniden kullanim tespiti tetiklenir.
 */
export async function refreshSession(): Promise<boolean> {
  if (refreshPromise) return refreshPromise;

  const token = getRefreshToken();
  if (!token) return false;

  refreshPromise = (async () => {
    try {
      const result = await rawRequest<{ tokens: TokenPair; user: SessionUser }>(
        '/auth/refresh',
        {
          method: 'POST',
          body: { refreshToken: token, device: getDeviceInfo() },
          skipRefresh: true,
        },
      );

      setTokens(result.tokens);
      emitSessionChange(result.user);
      return true;
    } catch {
      clearTokens();
      emitSessionChange(null);
      return false;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

// ---------------------------------------------------------------------------
// Kimlik uc noktalari
// ---------------------------------------------------------------------------

export const authApi = {
  login: (email: string, password: string, tenantCode?: string) =>
    request<LoginResponse>('/auth/login', {
      method: 'POST',
      body: { email, password, device: getDeviceInfo() },
      skipRefresh: true,
      headers: tenantCode ? { 'X-Tenant-Code': tenantCode } : undefined,
    }),

  verifyMfa: (challengeToken: string, code: string, trustDevice: boolean) =>
    request<LoginResponse>('/auth/mfa/verify', {
      method: 'POST',
      body: { challengeToken, code, trustDevice, device: getDeviceInfo() },
      skipRefresh: true,
    }),

  startEnrollment: (challengeToken: string) =>
    request<{
      secret: string;
      otpauthUri: string;
      qrCodeDataUrl: string;
      enrollmentToken: string;
      expiresIn: number;
    }>('/auth/mfa/enrollment', {
      method: 'POST',
      body: { challengeToken },
      skipRefresh: true,
    }),

  confirmEnrollment: (enrollmentToken: string, code: string) =>
    request<{ recoveryCodes: string[]; tokens: TokenPair; user: SessionUser }>(
      '/auth/mfa/enrollment/confirm',
      {
        method: 'POST',
        body: { enrollmentToken, code, device: getDeviceInfo() },
        skipRefresh: true,
      },
    ),

  forcedPasswordChange: (challengeToken: string, newPassword: string) =>
    request<LoginResponse>('/auth/password/forced-change', {
      method: 'POST',
      body: { challengeToken, newPassword, device: getDeviceInfo() },
      skipRefresh: true,
    }),

  me: () => request<SessionUser>('/auth/me'),

  logout: (allDevices: boolean) =>
    request<{ revokedSessions: number }>('/auth/logout', {
      method: 'POST',
      body: { allDevices },
    }),
};

export { emitSessionChange };
