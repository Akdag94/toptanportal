import {
  SetMetadata,
  applyDecorators,
  createParamDecorator,
  type ExecutionContext,
} from '@nestjs/common';
import type { Permission } from '@toptanportal/contracts';

import {
  getRequestContext,
  type AuthenticatedPrincipal,
} from '../context/request-context';

// ---------------------------------------------------------------------------
// Kimlik dogrulamasindan muaf uc noktalar
// ---------------------------------------------------------------------------

export const IS_PUBLIC_KEY = 'toptanportal:isPublic';

/**
 * Uc noktayi kimlik dogrulamasindan muaf tutar.
 * Bilincli bir karar oldugu her kullanimda kod incelemesinde sorgulanmalidir.
 */
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_PUBLIC_KEY, true);

// ---------------------------------------------------------------------------
// Yetki gereksinimleri
// ---------------------------------------------------------------------------

export const REQUIRED_PERMISSIONS_KEY = 'toptanportal:requiredPermissions';
export const PERMISSION_MODE_KEY = 'toptanportal:permissionMode';

export type PermissionMode = 'ALL' | 'ANY';

/** Verilen yetkilerin TAMAMINI gerektirir. */
export const RequirePermissions = (...permissions: Permission[]) =>
  applyDecorators(
    SetMetadata(REQUIRED_PERMISSIONS_KEY, permissions),
    SetMetadata<string, PermissionMode>(PERMISSION_MODE_KEY, 'ALL'),
  );

/** Verilen yetkilerden EN AZ BIRINI gerektirir. */
export const RequireAnyPermission = (...permissions: Permission[]) =>
  applyDecorators(
    SetMetadata(REQUIRED_PERMISSIONS_KEY, permissions),
    SetMetadata<string, PermissionMode>(PERMISSION_MODE_KEY, 'ANY'),
  );

// ---------------------------------------------------------------------------
// Hiz sinirlama
// ---------------------------------------------------------------------------

export const RATE_LIMIT_KEY = 'toptanportal:rateLimit';

export interface RateLimitOptions {
  /** Pencere basina izin verilen istek sayisi */
  limit: number;
  /** Pencere uzunlugu (saniye) */
  windowSeconds: number;
  /**
   * Sayacin neye gore tutulacagi.
   *  IP        - anonim uc noktalar (giris, sifre sifirlama)
   *  USER      - kimlikli uc noktalar
   *  IP_TARGET - IP + istek govdesindeki hedef (ornek: e-posta) birlikte
   */
  scope?: 'IP' | 'USER' | 'IP_TARGET';
  /** IP_TARGET kapsaminda hedefin okunacagi govde alani. */
  targetField?: string;
}

export const RateLimit = (options: RateLimitOptions): MethodDecorator & ClassDecorator =>
  SetMetadata(RATE_LIMIT_KEY, options);

// ---------------------------------------------------------------------------
// Kor Siparis Modu istisnasi
// ---------------------------------------------------------------------------

export const BLIND_ORDER_EXEMPT_KEY = 'toptanportal:blindOrderExempt';

/**
 * Yanit govdesini Kor Siparis suzgecinden muaf tutar.
 *
 * DIKKAT: Yalnizca finansal veri ICERMEYEN ve alan adlari yanlislikla
 * suzgece takilan uc noktalarda kullanilir (ornek: bir raporun "total" adli
 * kayit SAYISI alani). Finansal veri donen hicbir uc noktada kullanilamaz.
 */
export const BlindOrderExempt = (): MethodDecorator & ClassDecorator =>
  SetMetadata(BLIND_ORDER_EXEMPT_KEY, true);

// ---------------------------------------------------------------------------
// Parametre dekoratorleri
// ---------------------------------------------------------------------------

/**
 * Dogrulanmis kullaniciyi verir.
 * Guard zinciri gectiyse burada mutlaka bir deger vardir.
 */
export const CurrentUser = createParamDecorator(
  (property: keyof AuthenticatedPrincipal | undefined, _context: ExecutionContext) => {
    const principal = getRequestContext()?.principal;
    if (!principal) return undefined;
    return property ? principal[property] : principal;
  },
);

/** Istek izleme kimligi. */
export const RequestId = createParamDecorator(() => getRequestContext()?.requestId ?? null);

/** Istemcinin gercek IP adresi (Cloudflare arkasindan cozulmus). */
export const ClientIp = createParamDecorator(() => getRequestContext()?.ip ?? null);
