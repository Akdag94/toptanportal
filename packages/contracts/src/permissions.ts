/**
 * ToptanPortal - Yetki (Permission) Tanimlari ve Rol Matrisi
 *
 * Guard katmani DAIMA permission uzerinden calisir, rol uzerinden DEGIL.
 * Boylece ileride rol turevleri eklendiginde controller kodu degismez.
 */

import { UserRole } from './roles';

export const Permission = {
  // --- Katalog ---
  CATALOG_VIEW: 'catalog:view',
  CATALOG_MANAGE: 'catalog:manage',
  STOCK_VIEW: 'stock:view',

  // --- Finansal gorunurluk (KOR SIPARIS bu izinlerin yoklugu ile tanimlanir) ---
  PRICE_VIEW: 'price:view',
  DISCOUNT_VIEW: 'discount:view',
  BALANCE_VIEW: 'balance:view',
  STATEMENT_VIEW: 'statement:view',
  AGING_REPORT_VIEW: 'aging:view',
  INVOICE_DOWNLOAD: 'invoice:download',
  RECONCILIATION_DOWNLOAD: 'reconciliation:download',
  PAYMENT_CREATE: 'payment:create',

  // --- Siparis ---
  ORDER_DRAFT: 'order:draft',
  ORDER_SUBMIT_FOR_APPROVAL: 'order:submit-for-approval',
  ORDER_PLACE: 'order:place',
  ORDER_APPROVE: 'order:approve',
  ORDER_CANCEL: 'order:cancel',
  ORDER_VIEW_OWN: 'order:view:own',
  ORDER_VIEW_COMPANY: 'order:view:company',
  ORDER_VIEW_ALL: 'order:view:all',
  ORDER_IMPORT_BULK: 'order:import:bulk',
  ORDER_TEMPLATE_MANAGE: 'order-template:manage',

  // --- Kullanici yonetimi ---
  USER_MANAGE_COMPANY: 'user:manage:company',
  USER_MANAGE_ALL: 'user:manage:all',
  USER_LIMIT_MANAGE: 'user:limit:manage',

  // --- Cari / isletme ---
  COMPANY_VIEW_OWN: 'company:view:own',
  COMPANY_VIEW_ASSIGNED: 'company:view:assigned',
  COMPANY_VIEW_ALL: 'company:view:all',
  COMPANY_MANAGE: 'company:manage',

  // --- Plasiyer saha operasyonlari ---
  MASQUERADE: 'session:masquerade',
  VISIT_NOTE_MANAGE: 'visit-note:manage',
  COLLECTION_RECORD: 'collection:record',
  SALES_TARGET_VIEW_OWN: 'sales-target:view:own',
  /**
   * Hedef tanimlama ve TUM plasiyerlerin hedefini gorme.
   *
   * Gorme ve tanimlama tek yetkide birlesir cunku ikisi de ayni bilgiye
   * dayanir: baskasinin hedefini ve primini gormek, ekip icinde ucret
   * bilgisinin sizmasi demektir ve bu ayrimi yalnizca yonetici tasiyabilir.
   */
  SALES_TARGET_MANAGE: 'sales-target:manage',

  // --- Yonetim / sistem ---
  ADMIN_SETTINGS_MANAGE: 'admin:settings:manage',
  INTEGRATION_MANAGE: 'integration:manage',
  PRICE_LIST_MANAGE: 'price-list:manage',
  /**
   * Fiyati DEGISTIRME - ve degisikligi Logo'ya yazma.
   *
   * PRICE_LIST_MANAGE'den ayri tutulur cunku o yetki listeyi GORMEYI acar
   * ("bu bayi bu urunu kactan aliyor" sorusu her gun sorulur ve cevabi
   * gormek zararsizdir). Bu yetki ise portalden yazilan bir fiyatin Logo'ya
   * gecmesini, dolayisiyla kesilecek faturayi degistirir. Var olan bir
   * yetkinin anlamini genisletmek, o yetkiyi tasiyan herkese haberi olmadan
   * yeni bir guc vermektir.
   */
  PRICE_CHANGE: 'price:change',
  AUDIT_LOG_VIEW: 'audit:view',
  IP_WHITELIST_MANAGE: 'ip-whitelist:manage',
  /**
   * Bildirim gonderim kaydini gorme.
   *
   * Kendi tercihlerini yonetmek yetki ISTEMEZ - herkes kendi tercihini
   * degistirir. Bu yetki, "bu bayiye vade hatirlatmasi gitti mi" sorusunu
   * cevaplayan kaydi acar ve o kayit baskalarinin adreslerini icerir.
   */
  NOTIFICATION_LOG_VIEW: 'notification:log:view',
  /**
   * Bildirim metinlerini kiraci bazinda duzenleme.
   *
   * Gonderim kaydini GORMEKTEN ayri bir yetkidir: kayit gecmise bakar, sablon
   * ise bundan sonra gidecek her iletiyi degistirir. Metni degistiren kisi,
   * portalin bayiye verdigi sozun sozlerini degistiriyordur.
   */
  NOTIFICATION_TEMPLATE_MANAGE: 'notification:template:manage',
  /**
   * e-Belge kesme.
   *
   * INDIRMEDEN (INVOICE_DOWNLOAD) ayridir: indirme kesilmis bir belgeyi
   * okur, bu yetki YENI bir belge dogurur ve dogan belge geri alinamaz -
   * duzeltmesi ancak iade faturasiyla yapilir.
   */
  EDOCUMENT_ISSUE: 'e-document:issue',
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];

export const ALL_PERMISSIONS: readonly Permission[] = Object.values(Permission);

/**
 * Rol -> Yetki matrisi. GDD Bolum 2'deki tabloyu birebir uygular.
 */
export const ROLE_PERMISSIONS: Record<UserRole, readonly Permission[]> = {
  [UserRole.SUPER_ADMIN]: [
    Permission.CATALOG_VIEW,
    Permission.CATALOG_MANAGE,
    Permission.STOCK_VIEW,
    Permission.PRICE_VIEW,
    Permission.DISCOUNT_VIEW,
    Permission.BALANCE_VIEW,
    Permission.STATEMENT_VIEW,
    Permission.AGING_REPORT_VIEW,
    Permission.INVOICE_DOWNLOAD,
    Permission.RECONCILIATION_DOWNLOAD,
    Permission.ORDER_VIEW_ALL,
    Permission.ORDER_CANCEL,
    Permission.ORDER_APPROVE,
    Permission.USER_MANAGE_ALL,
    Permission.USER_MANAGE_COMPANY,
    Permission.USER_LIMIT_MANAGE,
    Permission.COMPANY_VIEW_ALL,
    Permission.COMPANY_MANAGE,
    Permission.SALES_TARGET_MANAGE,
    Permission.ADMIN_SETTINGS_MANAGE,
    Permission.INTEGRATION_MANAGE,
    Permission.PRICE_LIST_MANAGE,
    Permission.PRICE_CHANGE,
    Permission.AUDIT_LOG_VIEW,
    Permission.IP_WHITELIST_MANAGE,
    Permission.NOTIFICATION_LOG_VIEW,
    Permission.NOTIFICATION_TEMPLATE_MANAGE,
    Permission.EDOCUMENT_ISSUE,
  ],

  /**
   * Plasiyer: fiyat GORUR ama DEGISTIREMEZ (PRICE_LIST_MANAGE yok).
   * Sadece kendine atanmis cariler uzerinde islem yapar - scope kontrolu
   * CompanyScopeGuard tarafindan ayrica uygulanir.
   */
  [UserRole.SALES_REP]: [
    Permission.CATALOG_VIEW,
    Permission.STOCK_VIEW,
    Permission.PRICE_VIEW,
    Permission.DISCOUNT_VIEW,
    Permission.BALANCE_VIEW,
    Permission.STATEMENT_VIEW,
    Permission.AGING_REPORT_VIEW,
    Permission.ORDER_DRAFT,
    Permission.ORDER_PLACE,
    Permission.ORDER_VIEW_COMPANY,
    Permission.ORDER_IMPORT_BULK,
    Permission.COMPANY_VIEW_ASSIGNED,
    Permission.MASQUERADE,
    Permission.VISIT_NOTE_MANAGE,
    Permission.COLLECTION_RECORD,
    Permission.SALES_TARGET_VIEW_OWN,
  ],

  [UserRole.BUSINESS_OWNER]: [
    Permission.CATALOG_VIEW,
    Permission.STOCK_VIEW,
    Permission.PRICE_VIEW,
    Permission.DISCOUNT_VIEW,
    Permission.BALANCE_VIEW,
    Permission.STATEMENT_VIEW,
    Permission.AGING_REPORT_VIEW,
    Permission.INVOICE_DOWNLOAD,
    Permission.RECONCILIATION_DOWNLOAD,
    Permission.PAYMENT_CREATE,
    Permission.ORDER_DRAFT,
    Permission.ORDER_PLACE,
    Permission.ORDER_APPROVE,
    Permission.ORDER_CANCEL,
    Permission.ORDER_VIEW_COMPANY,
    Permission.ORDER_IMPORT_BULK,
    Permission.ORDER_TEMPLATE_MANAGE,
    Permission.USER_MANAGE_COMPANY,
    Permission.USER_LIMIT_MANAGE,
    Permission.COMPANY_VIEW_OWN,
  ],

  /**
   * KOR SIPARIS MODU.
   * Bu listede PRICE_VIEW / DISCOUNT_VIEW / BALANCE_VIEW / STATEMENT_VIEW /
   * INVOICE_DOWNLOAD / PAYMENT_CREATE BULUNMAZ. BlindOrderInterceptor bu
   * yoklugu okuyarak API yanitlarindan finansal alanlari fiziksel olarak siler.
   * Siparisi kendisi Logo'ya dusuremez; sadece onaya gonderir.
   */
  [UserRole.BUSINESS_STAFF]: [
    Permission.CATALOG_VIEW,
    Permission.STOCK_VIEW,
    Permission.ORDER_DRAFT,
    Permission.ORDER_SUBMIT_FOR_APPROVAL,
    Permission.ORDER_VIEW_OWN,
    Permission.ORDER_TEMPLATE_MANAGE,
  ],

  /**
   * Muhasebeci: evrak ve ekstre odakli.
   * ORDER_DRAFT / ORDER_PLACE YOK -> yeni siparis olusturamaz, sepet duzenleyemez.
   */
  [UserRole.BUSINESS_ACCOUNTANT]: [
    Permission.CATALOG_VIEW,
    Permission.PRICE_VIEW,
    Permission.DISCOUNT_VIEW,
    Permission.BALANCE_VIEW,
    Permission.STATEMENT_VIEW,
    Permission.AGING_REPORT_VIEW,
    Permission.INVOICE_DOWNLOAD,
    Permission.RECONCILIATION_DOWNLOAD,
    Permission.PAYMENT_CREATE,
    Permission.ORDER_VIEW_COMPANY,
    Permission.COMPANY_VIEW_OWN,
  ],
};

/** Sabit zamanli yetki sorgusu icin onceden hesaplanmis kumeler. */
const ROLE_PERMISSION_SETS: Record<UserRole, ReadonlySet<Permission>> = (() => {
  const sets = {} as Record<UserRole, ReadonlySet<Permission>>;

  for (const role of Object.keys(ROLE_PERMISSIONS) as UserRole[]) {
    sets[role] = new Set(ROLE_PERMISSIONS[role]);
  }

  return sets;
})();

export function getPermissionsForRole(role: UserRole): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

export function roleHasPermission(role: UserRole, permission: Permission): boolean {
  return ROLE_PERMISSION_SETS[role].has(permission);
}

export function roleHasAllPermissions(
  role: UserRole,
  permissions: readonly Permission[],
): boolean {
  const set = ROLE_PERMISSION_SETS[role];
  return permissions.every((p) => set.has(p));
}

export function roleHasAnyPermission(
  role: UserRole,
  permissions: readonly Permission[],
): boolean {
  const set = ROLE_PERMISSION_SETS[role];
  return permissions.some((p) => set.has(p));
}

/**
 * Finansal veri gorme yetkisi. Kor Siparis Modu kontrolunun tek karar noktasi.
 * PRICE_VIEW yoksa kullanici hicbir parasal degeri goremez.
 */
export function canSeeFinancials(role: UserRole): boolean {
  return roleHasPermission(role, Permission.PRICE_VIEW);
}
