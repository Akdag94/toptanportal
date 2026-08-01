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
  AccountSummary,
  ActiveSession,
  AgingReport,
  ApiErrorBody,
  ApplyTemplateResult,
  CartItemInput,
  CartView,
  AssignRepRequest,
  AuditPage,
  AuditQuery,
  AuditVerifyResult,
  BulkImportResult,
  CardPaymentForm,
  CatalogPage,
  CompanyListQuery,
  CompanyPage,
  CreateVisitNoteRequest,
  CatalogProduct,
  DbsBatchView,
  DbsImportResult,
  DeadEventView,
  EDocumentFormat,
  InviteUserRequest,
  InviteUserResult,
  ManagedUser,
  EDocumentLink,
  EDocumentPage,
  EDocumentQuery,
  EDocumentSummary,
  ErrorCode,
  IssueEDocumentRequest,
  IssueEDocumentResult,
  IntegrationStatus,
  LoginResponse,
  OrderListQuery,
  OrderTemplateView,
  OrderView,
  PaymentListQuery,
  PaymentPage,
  NotificationPage,
  NotificationPreferences,
  NotificationQuery,
  NotificationTemplateList,
  NotificationTemplatePreviewRequest,
  NotificationTemplatePreviewResult,
  UpsertNotificationTemplateRequest,
  PaymentView,
  PlaceOrderRequest,
  PlaceOrderResult,
  PriceListItemPage,
  PriceListItemQuery,
  PriceListView,
  PosTransactionView,
  RecordPaymentRequest,
  SessionUser,
  StatementPage,
  StatementQuery,
  SalesTarget,
  SalesTargetQuery,
  SetSpendingLimitRequest,
  StartCardPaymentRequest,
  StockShortage,
  SyncChannel,
  SyncRunResult,
  UpdatePreferencesRequest,
  TokenPair,
  UpsertSalesTargetRequest,
  UserListQuery,
  UserPage,
  VisitNote,
  VisitNotePage,
  VisitNoteQuery,
} from '@toptanportal/contracts';

import { getDeviceInfo } from './device';

const REFRESH_TOKEN_KEY = 'toptanportal.refreshToken';

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, '') ?? 'http://localhost:3001';

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: Record<string, string[]>;
  readonly context?: Record<string, unknown>;
  readonly requestId: string;

  constructor(body: ApiErrorBody) {
    super(body.message);
    this.name = 'ApiError';
    this.code = body.code;
    this.statusCode = body.statusCode;
    this.details = body.details;
    this.context = body.context;
    this.requestId = body.requestId;
  }

  /**
   * Stok yetersizliginde hangi satirlarin sorunlu oldugu.
   * Kor Siparis Modunda `available` alani GELMEZ; arayuz bu alanin varligini
   * kontrol etmeli, degerine guvenmemelidir.
   */
  get stockShortages(): StockShortage[] {
    const shortages = this.context?.shortages;
    return Array.isArray(shortages) ? (shortages as StockShortage[]) : [];
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

  /**
   * Gonullu 2FA kaydi. Zorunlu akistan (mfa/enrollment) ayridir: burada
   * kullanici zaten oturum acmistir ve kaydi kendi istegiyle baslatir.
   */
  setupMfa: () =>
    request<{
      secret: string;
      otpauthUri: string;
      qrCodeDataUrl: string;
      enrollmentToken: string;
      expiresIn: number;
    }>('/auth/mfa/setup', { method: 'POST', body: getDeviceInfo() }),

  confirmSetupMfa: (code: string) =>
    request<{ recoveryCodes: string[] }>('/auth/mfa/setup/confirm', {
      method: 'POST',
      body: { code },
    }),

  sessions: () => request<{ sessions: ActiveSession[] }>('/auth/sessions'),

  revokeSession: (sessionId: string) =>
    request<void>(`/auth/sessions/${sessionId}`, { method: 'DELETE' }),

  logout: (allDevices: boolean) =>
    request<{ revokedSessions: number }>('/auth/logout', {
      method: 'POST',
      body: { allDevices },
    }),
};

// ---------------------------------------------------------------------------
// Katalog, sepet ve siparis uc noktalari
//
// KOR SIPARIS NOTU: Asagidaki tiplerde fiyat alanlari opsiyoneldir cunku
// sunucu yetkisi olmayan kullaniciya bu alanlari HIC gondermez. Arayuz
// `typeof x === 'number'` kontrolu yapmali, `x ?? 0` gibi varsayilan
// ATAMAMALIDIR - sifir fiyat, gizlenmis fiyattan farksiz gorunur.
// ---------------------------------------------------------------------------

export interface CatalogFilters {
  q?: string;
  category?: string;
  brand?: string;
  inStockOnly?: boolean;
  cursor?: string;
  limit?: number;
}

function toQuery(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }

  const query = search.toString();
  return query.length > 0 ? `?${query}` : '';
}

export const catalogApi = {
  list: (filters: CatalogFilters = {}) =>
    request<CatalogPage>(`/catalog/products${toQuery({ ...filters })}`),

  detail: (productId: string) => request<CatalogProduct>(`/catalog/products/${productId}`),

  byBarcode: (barcode: string) =>
    request<{ product: CatalogProduct; matchedUnitCode: string | null }>('/catalog/barcode', {
      method: 'POST',
      body: { barcode },
    }),
};

export const cartApi = {
  get: () => request<CartView>('/cart'),

  replace: (items: CartItemInput[], note?: string) =>
    request<CartView>('/cart', { method: 'PUT', body: { items, note } }),

  addItem: (item: CartItemInput) =>
    request<CartView>('/cart/items', { method: 'POST', body: item }),

  setQuantity: (productId: string, unitId: string, quantity: number) =>
    request<CartView>(`/cart/items/${productId}/${unitId}`, {
      method: 'PATCH',
      body: { quantity },
    }),

  removeItem: (productId: string, unitId: string) =>
    request<CartView>(`/cart/items/${productId}/${unitId}`, { method: 'DELETE' }),

  clear: () => request<CartView>('/cart', { method: 'DELETE' }),

  /**
   * Excel listesini sepete cevirir. Dosya TARAYICIDA metne cevrilip
   * gonderilir; coklu parcali yukleme hem arayuze hem sunucuya gereksiz bir
   * katman ekler ve CSV zaten metindir.
   */
  bulkImport: (content: string, replaceExisting: boolean) =>
    request<BulkImportResult>('/cart/bulk-import', {
      method: 'POST',
      body: { content, replaceExisting },
    }),
};

export const orderApi = {
  /**
   * Idempotency-Key zorunlu gonderilir: zayif baglantida kullanici "Siparişi
   * Tamamla" dugmesine iki kez basarsa ikinci istek yeni siparis ACMAZ.
   */
  place: (body: PlaceOrderRequest, idempotencyKey: string) =>
    request<PlaceOrderResult>('/orders', {
      method: 'POST',
      body,
      headers: { 'Idempotency-Key': idempotencyKey },
    }),

  list: (query: Partial<OrderListQuery> = {}) =>
    request<{ items: OrderView[]; nextCursor: string | null }>(
      `/orders${toQuery({ ...query })}`,
    ),

  detail: (orderId: string) => request<OrderView>(`/orders/${orderId}`),

  approve: (orderId: string) =>
    request<OrderView>(`/orders/${orderId}/approve`, { method: 'POST' }),

  reject: (orderId: string, reason: string) =>
    request<OrderView>(`/orders/${orderId}/reject`, { method: 'POST', body: { reason } }),

  cancel: (orderId: string) =>
    request<OrderView>(`/orders/${orderId}/cancel`, { method: 'POST' }),
};

export const templateApi = {
  list: () => request<OrderTemplateView[]>('/order-templates'),

  createFromCart: (name: string, isShared: boolean) =>
    request<OrderTemplateView>('/order-templates/from-cart', {
      method: 'POST',
      body: { name, isShared },
    }),

  apply: (templateId: string) =>
    request<ApplyTemplateResult>(`/order-templates/${templateId}/apply`, { method: 'POST' }),

  remove: (templateId: string) =>
    request<void>(`/order-templates/${templateId}`, { method: 'DELETE' }),
};

// ---------------------------------------------------------------------------
// Cari hesap ve tahsilat uc noktalari
//
// KOR SIPARIS NOTU: Bu uc noktalarin hicbiri alt yetkili hesapta CAGRILMAZ -
// menu ve sayfalar BALANCE_VIEW / STATEMENT_VIEW yetkisi yoksa hic olusmaz.
// Yine de bir cagri sizarsa sunucu 403 doner; arayuz bunu hata olarak gosterir,
// bos veri uydurmaz.
// ---------------------------------------------------------------------------

export const financeApi = {
  summary: (companyId?: string) =>
    request<AccountSummary>(`/finance/summary${toQuery({ companyId })}`),

  statement: (query: Partial<StatementQuery> = {}) =>
    request<StatementPage>(`/finance/statement${toQuery({ ...query })}`),

  aging: (companyId?: string) =>
    request<AgingReport>(`/finance/aging${toQuery({ companyId })}`),

  /**
   * Idempotency-Key zorunlu: cift gonderim ikinci bir tahsilat kaydi ACMAZ.
   * Tahsilat, cari bakiyeyi dogrudan degistirdigi icin siparisten daha az
   * affedicidir - yanlislikla iki kez kaydedilen odeme mutabakati bozar.
   */
  recordPayment: (body: RecordPaymentRequest, idempotencyKey: string) =>
    request<PaymentView>('/finance/payments', {
      method: 'POST',
      body,
      headers: { 'Idempotency-Key': idempotencyKey },
    }),

  payments: (query: Partial<PaymentListQuery> = {}) =>
    request<PaymentPage>(`/finance/payments${toQuery({ ...query })}`),

  confirmPayment: (paymentId: string) =>
    request<PaymentView>(`/finance/payments/${paymentId}/confirm`, { method: 'POST' }),

  cancelPayment: (paymentId: string, reason: string) =>
    request<PaymentView>(`/finance/payments/${paymentId}/cancel`, {
      method: 'POST',
      body: { reason },
    }),
};

// ---------------------------------------------------------------------------
// Logo entegrasyonu (yalnizca INTEGRATION_MANAGE yetkisi)
// ---------------------------------------------------------------------------

export const integrationApi = {
  status: () => request<IntegrationStatus>('/integration/status'),

  /** Köprüyü şimdi yoklar ve tazelenmiş durumu döner. */
  probe: () => request<IntegrationStatus>('/integration/probe', { method: 'POST' }),

  deadEvents: () => request<DeadEventView[]>('/integration/dead-events'),

  retryDeadEvents: (eventIds?: string[]) =>
    request<{ requeued: number }>('/integration/dead-events/retry', {
      method: 'POST',
      body: { eventIds },
    }),

  sync: (channel: SyncChannel, fullResync = false) =>
    request<SyncRunResult | null>('/integration/sync', {
      method: 'POST',
      body: { channel, fullResync },
    }),

  toggleChannel: (channel: SyncChannel, enabled: boolean) =>
    request<IntegrationStatus>(
      `/integration/channels/toggle${toQuery({ channel, enabled })}`,
      { method: 'POST' },
    ),
};

// ---------------------------------------------------------------------------
// Sanal POS ve DBS
// ---------------------------------------------------------------------------

export const posApi = {
  /** Kart ile odeme acik mi - dugme buna gore cizilir. */
  availability: () => request<{ enabled: boolean }>('/pos/availability'),

  start: (body: StartCardPaymentRequest) =>
    request<CardPaymentForm>('/pos/card-payments', { method: 'POST', body }),

  get: (transactionId: string) =>
    request<PosTransactionView>(`/pos/card-payments/${transactionId}`),
};

export const dbsApi = {
  batches: () => request<DbsBatchView[]>('/dbs/batches'),

  exportDebts: (dueUntil: string, bankCode: string) =>
    request<{ content: string; fileName: string; batch: DbsBatchView }>(
      `/dbs/export${toQuery({ dueUntil, bankCode })}`,
      { method: 'POST' },
    ),

  importResults: (bankCode: string, fileName: string, content: string) =>
    request<DbsImportResult>('/dbs/import', {
      method: 'POST',
      body: { bankCode, fileName, content },
    }),
};

// ---------------------------------------------------------------------------
// e-Belge arsivi
// ---------------------------------------------------------------------------

export const eDocumentApi = {
  list: (query: Partial<EDocumentQuery> = {}) =>
    request<EDocumentPage>(`/e-documents${toQuery({ ...query })}`),

  summary: (query: Partial<EDocumentQuery> = {}) =>
    request<EDocumentSummary>(`/e-documents/summary${toQuery({ ...query })}`),

  /**
   * Indirme baglantisi uretir. Baglanti kisa omurludur ve indiren kisiyi
   * icinde tasir; bu yuzden ONCE uretilir, sonra tarayici ona gider.
   */
  link: (documentId: string, format: EDocumentFormat) =>
    request<EDocumentLink>(`/e-documents/${documentId}/link${toQuery({ format })}`),

  /**
   * Siparisten belge keser. GERI ALINAMAZ: numara tuketilir, belge hukuken
   * dogar ve duzeltmesi ancak iade faturasiyla yapilir.
   *
   * Uc nokta belgeyi keser, GONDERMEZ; entegratore iletim bakim gorevinden
   * yapilir ve kullanici saglayicinin yanit suresini beklemez.
   */
  issue: (body: IssueEDocumentRequest) =>
    request<IssueEDocumentResult>('/e-documents/issue', { method: 'POST', body }),
};

// ---------------------------------------------------------------------------
// Saha: portfoy, ziyaret, hedef
// ---------------------------------------------------------------------------

export const fieldApi = {
  companies: (query: Partial<CompanyListQuery> = {}) =>
    request<CompanyPage>(`/companies${toQuery({ ...query })}`),

  assign: (body: AssignRepRequest) =>
    request<{ affected: number }>('/companies/assignments', { method: 'POST', body }),

  visits: (query: Partial<VisitNoteQuery> = {}) =>
    request<VisitNotePage>(`/visits${toQuery({ ...query })}`),

  createVisit: (body: CreateVisitNoteRequest) =>
    request<VisitNote>('/visits', { method: 'POST', body }),

  targets: (query: Partial<SalesTargetQuery> = {}) =>
    request<SalesTarget[]>(`/sales-targets${toQuery({ ...query })}`),

  upsertTarget: (body: UpsertSalesTargetRequest) =>
    request<SalesTarget>('/sales-targets', { method: 'POST', body }),
};

// ---------------------------------------------------------------------------
// Denetim kayitlari (yalnizca AUDIT_LOG_VIEW)
// ---------------------------------------------------------------------------

export const auditApi = {
  list: (query: Partial<AuditQuery> = {}) =>
    request<AuditPage>(`/audit${toQuery({ ...query })}`),

  verify: () => request<AuditVerifyResult>('/audit/verify', { method: 'POST' }),
};

// ---------------------------------------------------------------------------
// Kullanici yonetimi
// ---------------------------------------------------------------------------

export const userApi = {
  list: (query: Partial<UserListQuery> = {}) =>
    request<UserPage>(`/users${toQuery({ ...query })}`),

  /**
   * Kullanici davet eder. Yanittaki gecici sifre YALNIZCA bu cagrida gelir;
   * arayuz onu kullaniciya gostermeden kaybederse yeniden alinamaz.
   */
  invite: (body: InviteUserRequest) =>
    request<InviteUserResult>('/users', { method: 'POST', body }),

  setStatus: (userId: string, status: 'ACTIVE' | 'SUSPENDED') =>
    request<ManagedUser>(`/users/${userId}/status`, { method: 'POST', body: { status } }),

  setSpendingLimit: (userId: string, body: SetSpendingLimitRequest) =>
    request<ManagedUser>(`/users/${userId}/spending-limit`, { method: 'POST', body }),
};

// ---------------------------------------------------------------------------
// Fiyat listeleri (salt okunur - fiyatlar Logo'dan gelir)
// ---------------------------------------------------------------------------

export const priceListApi = {
  list: () => request<PriceListView[]>('/price-lists'),

  items: (query: PriceListItemQuery) =>
    request<PriceListItemPage>(`/price-lists/items${toQuery({ ...query })}`),
};

// ---------------------------------------------------------------------------
// Bildirimler
//
// Tercihler ve cihaz kaydi yetki istemez - herkes kendi tercihini yonetir.
// Gonderim kaydi ise NOTIFICATION_LOG_VIEW ister; o kayit baskalarinin
// adreslerini tasir.
// ---------------------------------------------------------------------------

export const notificationApi = {
  preferences: () => request<NotificationPreferences>('/notifications/preferences'),

  updatePreferences: (body: UpdatePreferencesRequest) =>
    request<NotificationPreferences>('/notifications/preferences', { method: 'PUT', body }),

  list: (query: Partial<NotificationQuery> = {}) =>
    request<NotificationPage>(`/notifications${toQuery({ ...query })}`),

  labels: () =>
    request<{ topics: Record<string, string>; channels: Record<string, string> }>(
      '/notifications/labels',
    ),

  templates: () => request<NotificationTemplateList>('/notifications/templates'),

  saveTemplate: (body: UpsertNotificationTemplateRequest) =>
    request<NotificationTemplateList>('/notifications/templates', { method: 'PUT', body }),

  /* Onizleme KAYDETMEZ: hatali bir metnin yururlukte kaldigi bir aralik
     birakmamak icin sablon once gorulur, sonra kaydedilir. */
  previewTemplate: (body: NotificationTemplatePreviewRequest) =>
    request<NotificationTemplatePreviewResult>('/notifications/templates/preview', {
      method: 'POST',
      body,
    }),

  resetTemplate: (topic: string, channel: string) =>
    request<NotificationTemplateList>(`/notifications/templates/${topic}/${channel}`, {
      method: 'DELETE',
    }),
};

export { emitSessionChange };
