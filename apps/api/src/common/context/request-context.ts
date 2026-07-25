/**
 * ToptanPortal - Istek Baglami (Request Context)
 *
 * AsyncLocalStorage sayesinde; audit servisi, hata filtresi ve diger derin
 * katmanlar `request` nesnesini parametre olarak tasimadan istegin IP, kullanici
 * ve requestId bilgisine ulasabilir. Yasal delil loglamasinda bu bilgilerin
 * ASLA eksik kalmamasi gerekir - parametre gecirmeyi unutmak en sik yapilan
 * hatadir, bu tasarim o hatayi imkansiz kilar.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { UserRole, Permission } from '@toptanportal/contracts';

export interface AuthenticatedPrincipal {
  userId: string;
  tenantId: string;
  companyId: string | null;
  email: string;
  fullName: string;
  role: UserRole;
  permissions: readonly Permission[];
  sessionId: string;
  blindOrderMode: boolean;
  /** Plasiyer bayi adina islem yapiyorsa hedef cari kimligi. */
  masqueradeCompanyId: string | null;
}

export interface RequestContext {
  requestId: string;
  ip: string;
  country: string | null;
  city: string | null;
  userAgent: string | null;
  method: string;
  path: string;
  startedAt: number;
  principal: AuthenticatedPrincipal | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, callback: () => T): T {
  return storage.run(context, callback);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Kimlik dogrulandiktan sonra baglami zenginlestirir.
 * Guard'lar tarafindan cagirilir.
 */
export function setPrincipal(principal: AuthenticatedPrincipal): void {
  const context = storage.getStore();
  if (context) {
    context.principal = principal;
  }
}

/**
 * Islem yapilan efektif cari kimligi.
 * Plasiyer masquerading modundaysa hedef cari, degilse kullanicinin kendi carisi.
 */
export function getEffectiveCompanyId(): string | null {
  const context = storage.getStore();
  if (!context?.principal) return null;
  return context.principal.masqueradeCompanyId ?? context.principal.companyId;
}
