/**
 * ToptanPortal - Rol Tanimlari
 *
 * Sistem 5 katmanli bir yetki matrisi kullanir. Roller veritabaninda enum olarak
 * saklanir; buradaki degerler Prisma `UserRole` enum degerleri ile birebir aynidir.
 */

export const UserRole = {
  /** Toptanci yonetimi. Tam kontrol. 2FA + IP whitelist zorunlu. */
  SUPER_ADMIN: 'SUPER_ADMIN',
  /** Plasiyer / saha satis temsilcisi. Sadece atanmis carileri gorur. */
  SALES_REP: 'SALES_REP',
  /** Isletme ana yetkilisi (kafe sahibi / satin alma). Tum finansal veriyi gorur. */
  BUSINESS_OWNER: 'BUSINESS_OWNER',
  /** Isletme alt yetkilisi (barista / depo). KOR SIPARIS MODU. */
  BUSINESS_STAFF: 'BUSINESS_STAFF',
  /** Isletme muhasebecisi. Evrak ve ekstre odakli, siparis veremez. */
  BUSINESS_ACCOUNTANT: 'BUSINESS_ACCOUNTANT',
} as const;

export type UserRole = (typeof UserRole)[keyof typeof UserRole];

export const ALL_ROLES: readonly UserRole[] = Object.values(UserRole);

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && (ALL_ROLES as readonly string[]).includes(value);
}

/** Bir isletmeye (cari) bagli olmasi zorunlu roller. */
export const COMPANY_SCOPED_ROLES: readonly UserRole[] = [
  UserRole.BUSINESS_OWNER,
  UserRole.BUSINESS_STAFF,
  UserRole.BUSINESS_ACCOUNTANT,
];

/** Toptanci (satici) tarafinda calisan, tek bir cariye bagli olmayan roller. */
export const SUPPLIER_SIDE_ROLES: readonly UserRole[] = [
  UserRole.SUPER_ADMIN,
  UserRole.SALES_REP,
];

/**
 * 2FA zorunlulugu.
 * GDD Bolum 5: "Super Adminler, Finans yetkilileri ve Ana Isletme sahipleri icin
 * SMS OTP veya TOTP tabanli 2FA zorunlulugu."
 */
export const MFA_MANDATORY_ROLES: readonly UserRole[] = [
  UserRole.SUPER_ADMIN,
  UserRole.BUSINESS_OWNER,
  UserRole.BUSINESS_ACCOUNTANT,
];

export function isMfaMandatory(role: UserRole): boolean {
  return MFA_MANDATORY_ROLES.includes(role);
}

/**
 * IP beyaz liste zorunlulugu. Sadece Super Admin.
 * GDD Bolum 2: "Sadece beyaz listeye alinmis IP adreslerinden erisim saglanabilir."
 */
export const IP_WHITELIST_ENFORCED_ROLES: readonly UserRole[] = [UserRole.SUPER_ADMIN];

export function isIpWhitelistEnforced(role: UserRole): boolean {
  return IP_WHITELIST_ENFORCED_ROLES.includes(role);
}

/**
 * KOR SIPARIS MODU (Blind Order).
 * GDD Bolum 2: Isletme Alt Yetkilisi fiyat, iskonto, fatura ve cari borcu
 * KESINLIKLE GOREMEZ. Bu liste rol bazlidir ve kullanici bazinda override
 * EDILEMEZ - guvenlik gereksinimi mutlaktir.
 */
export const BLIND_ORDER_ROLES: readonly UserRole[] = [UserRole.BUSINESS_STAFF];

export function isBlindOrderRole(role: UserRole): boolean {
  return BLIND_ORDER_ROLES.includes(role);
}

/** Insan tarafindan okunabilir rol etiketleri (TR). */
export const ROLE_LABELS: Record<UserRole, string> = {
  [UserRole.SUPER_ADMIN]: 'Süper Admin',
  [UserRole.SALES_REP]: 'Satış Temsilcisi',
  [UserRole.BUSINESS_OWNER]: 'İşletme Ana Yetkilisi',
  [UserRole.BUSINESS_STAFF]: 'İşletme Alt Yetkilisi',
  [UserRole.BUSINESS_ACCOUNTANT]: 'İşletme Muhasebecisi',
};

/** Rolun oncelikli calistigi platform - istemci yonlendirmesi icin. */
export const ROLE_PRIMARY_PLATFORM: Record<UserRole, 'WEB' | 'IOS' | 'BOTH'> = {
  [UserRole.SUPER_ADMIN]: 'WEB',
  [UserRole.SALES_REP]: 'BOTH',
  [UserRole.BUSINESS_OWNER]: 'BOTH',
  [UserRole.BUSINESS_STAFF]: 'IOS',
  [UserRole.BUSINESS_ACCOUNTANT]: 'WEB',
};
