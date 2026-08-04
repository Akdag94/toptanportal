/**
 * Rol/yetki matrisinin testleri.
 *
 * Bu dosya bir GUVENLIK SOZLESMESIDIR. Buradaki bir testin kirilmasi, ya kasitli
 * bir mevzuat/urun karari alindigi ya da Kor Siparis Modunun yanlislikla
 * delindigi anlamina gelir. Ikisi de kod incelemesinde acikca tartisilmalidir.
 */

import { describe, expect, it } from 'vitest';

import {
  ALL_PERMISSIONS,
  Permission,
  ROLE_PERMISSIONS,
  canSeeFinancials,
  getPermissionsForRole,
  roleHasAllPermissions,
  roleHasAnyPermission,
  roleHasPermission,
} from './permissions';
import { UserRole } from './roles';

/** Kor Siparis Modunda BULUNMAMASI gereken yetkiler. */
const FINANCIAL_PERMISSIONS = [
  Permission.PRICE_VIEW,
  Permission.DISCOUNT_VIEW,
  Permission.BALANCE_VIEW,
  Permission.STATEMENT_VIEW,
  Permission.AGING_REPORT_VIEW,
  Permission.INVOICE_DOWNLOAD,
  Permission.RECONCILIATION_DOWNLOAD,
  Permission.PAYMENT_CREATE,
] as const;

describe('Kör Sipariş Modu — BUSINESS_STAFF', () => {
  it.each(FINANCIAL_PERMISSIONS)('%s yetkisine sahip DEĞİLDİR', (permission) => {
    expect(roleHasPermission(UserRole.BUSINESS_STAFF, permission)).toBe(false);
  });

  it('canSeeFinancials false döner — kör mod kararının tek noktası', () => {
    expect(canSeeFinancials(UserRole.BUSINESS_STAFF)).toBe(false);
  });

  it('siparişi kendisi Logo\'ya düşüremez, yalnızca onaya gönderir', () => {
    expect(roleHasPermission(UserRole.BUSINESS_STAFF, Permission.ORDER_PLACE)).toBe(false);
    expect(roleHasPermission(UserRole.BUSINESS_STAFF, Permission.ORDER_SUBMIT_FOR_APPROVAL)).toBe(
      true,
    );
  });

  it('kendi siparişini onaylayamaz', () => {
    expect(roleHasPermission(UserRole.BUSINESS_STAFF, Permission.ORDER_APPROVE)).toBe(false);
  });

  it('yalnızca kendi siparişlerini görür', () => {
    expect(roleHasPermission(UserRole.BUSINESS_STAFF, Permission.ORDER_VIEW_OWN)).toBe(true);
    expect(roleHasPermission(UserRole.BUSINESS_STAFF, Permission.ORDER_VIEW_COMPANY)).toBe(false);
    expect(roleHasPermission(UserRole.BUSINESS_STAFF, Permission.ORDER_VIEW_ALL)).toBe(false);
  });

  it('katalog ve stok durumunu görebilir — sipariş verebilmesi için gerekli', () => {
    expect(roleHasPermission(UserRole.BUSINESS_STAFF, Permission.CATALOG_VIEW)).toBe(true);
    expect(roleHasPermission(UserRole.BUSINESS_STAFF, Permission.STOCK_VIEW)).toBe(true);
    expect(roleHasPermission(UserRole.BUSINESS_STAFF, Permission.ORDER_DRAFT)).toBe(true);
  });
});

describe('Rol sınırları', () => {
  it('plasiyer fiyatı görür ama fiyat listesini değiştiremez', () => {
    expect(canSeeFinancials(UserRole.SALES_REP)).toBe(true);
    expect(roleHasPermission(UserRole.SALES_REP, Permission.PRICE_LIST_MANAGE)).toBe(false);
  });

  it('plasiyer yalnızca kendine atanmış carileri görür', () => {
    expect(roleHasPermission(UserRole.SALES_REP, Permission.COMPANY_VIEW_ASSIGNED)).toBe(true);
    expect(roleHasPermission(UserRole.SALES_REP, Permission.COMPANY_VIEW_ALL)).toBe(false);
  });

  it('muhasebeci sipariş oluşturamaz ve sepet düzenleyemez', () => {
    expect(roleHasPermission(UserRole.BUSINESS_ACCOUNTANT, Permission.ORDER_DRAFT)).toBe(false);
    expect(roleHasPermission(UserRole.BUSINESS_ACCOUNTANT, Permission.ORDER_PLACE)).toBe(false);
  });

  it('muhasebeci evrak ve ekstre erişimine sahiptir', () => {
    expect(
      roleHasAllPermissions(UserRole.BUSINESS_ACCOUNTANT, [
        Permission.STATEMENT_VIEW,
        Permission.INVOICE_DOWNLOAD,
        Permission.RECONCILIATION_DOWNLOAD,
      ]),
    ).toBe(true);
  });

  it('yalnızca plasiyer bayi adına işlem yapabilir', () => {
    const allowed = Object.values(UserRole).filter((role) =>
      roleHasPermission(role, Permission.MASQUERADE),
    );

    expect(allowed).toEqual([UserRole.SALES_REP]);
  });

  it('yalnızca yönetici IP beyaz listesini ve denetim kaydını yönetir', () => {
    const admins = Object.values(UserRole).filter((role) =>
      roleHasAnyPermission(role, [Permission.IP_WHITELIST_MANAGE, Permission.AUDIT_LOG_VIEW]),
    );

    expect(admins).toEqual([UserRole.SUPER_ADMIN]);
  });

  it('fiyatı Logo\'ya yazma yetkisi yalnızca yöneticidedir', () => {
    const allowed = Object.values(UserRole).filter((role) =>
      roleHasPermission(role, Permission.PRICE_CHANGE),
    );

    expect(allowed).toEqual([UserRole.SUPER_ADMIN]);
  });

  it('fiyatı değiştirebilen rol, fiyatı görebilir de', () => {
    for (const role of Object.values(UserRole)) {
      if (!roleHasPermission(role, Permission.PRICE_CHANGE)) continue;

      expect(
        roleHasPermission(role, Permission.PRICE_VIEW),
        `${role} fiyat değiştirebiliyor ama fiyat göremiyor`,
      ).toBe(true);
    }
  });

  it('katalog kartı açma yetkisi yalnızca yöneticidedir', () => {
    const allowed = Object.values(UserRole).filter((role) =>
      roleHasPermission(role, Permission.CATALOG_MANAGE),
    );

    expect(allowed).toEqual([UserRole.SUPER_ADMIN]);
  });

  it('işletme ana yetkilisi alt kullanıcı limitlerini tanımlayabilir', () => {
    expect(roleHasPermission(UserRole.BUSINESS_OWNER, Permission.USER_LIMIT_MANAGE)).toBe(true);
    expect(roleHasPermission(UserRole.BUSINESS_STAFF, Permission.USER_LIMIT_MANAGE)).toBe(false);
  });
});

describe('Matris bütünlüğü', () => {
  it('her rol için yetki listesi tanımlıdır', () => {
    for (const role of Object.values(UserRole)) {
      expect(getPermissionsForRole(role)).toBeDefined();
    }
  });

  it('matriste tanımsız veya yinelenen yetki yoktur', () => {
    const known = new Set<string>(ALL_PERMISSIONS);

    for (const [role, permissions] of Object.entries(ROLE_PERMISSIONS)) {
      expect(new Set(permissions).size, `${role} içinde yinelenen yetki var`).toBe(
        permissions.length,
      );

      for (const permission of permissions) {
        expect(known.has(permission), `${role} bilinmeyen yetki taşıyor: ${permission}`).toBe(true);
      }
    }
  });

  it('sipariş onayı olan her rol, siparişi görebilme yetkisine de sahiptir', () => {
    for (const role of Object.values(UserRole)) {
      if (!roleHasPermission(role, Permission.ORDER_APPROVE)) continue;

      expect(
        roleHasAnyPermission(role, [Permission.ORDER_VIEW_COMPANY, Permission.ORDER_VIEW_ALL]),
        `${role} onaylayabiliyor ama siparişi göremiyor`,
      ).toBe(true);
    }
  });

  it('finansal veri gören her rol, tutarları içeren siparişleri de görebilir', () => {
    for (const role of Object.values(UserRole)) {
      if (!canSeeFinancials(role)) continue;

      expect(
        roleHasAnyPermission(role, [
          Permission.ORDER_VIEW_OWN,
          Permission.ORDER_VIEW_COMPANY,
          Permission.ORDER_VIEW_ALL,
        ]),
      ).toBe(true);
    }
  });
});
