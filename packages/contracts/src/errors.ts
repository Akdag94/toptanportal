/**
 * ToptanPortal - Standart Hata Kodlari
 *
 * Istemciler (Web/iOS) hata mesajini degil, hata KODUNU dallanma icin kullanir.
 * Mesajlar lokalize edilebilir; kodlar sabittir.
 */

export const ErrorCode = {
  // Kimlik
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  ACCOUNT_SUSPENDED: 'ACCOUNT_SUSPENDED',
  ACCOUNT_INVITED_NOT_ACTIVE: 'ACCOUNT_INVITED_NOT_ACTIVE',
  MFA_REQUIRED: 'MFA_REQUIRED',
  MFA_INVALID_CODE: 'MFA_INVALID_CODE',
  MFA_CHALLENGE_EXPIRED: 'MFA_CHALLENGE_EXPIRED',
  MFA_ALREADY_ENROLLED: 'MFA_ALREADY_ENROLLED',
  MFA_NOT_ENROLLED: 'MFA_NOT_ENROLLED',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  SESSION_REVOKED: 'SESSION_REVOKED',
  REFRESH_TOKEN_INVALID: 'REFRESH_TOKEN_INVALID',
  REFRESH_TOKEN_REUSED: 'REFRESH_TOKEN_REUSED',

  // Yetki
  FORBIDDEN: 'FORBIDDEN',
  INSUFFICIENT_PERMISSION: 'INSUFFICIENT_PERMISSION',
  IP_NOT_WHITELISTED: 'IP_NOT_WHITELISTED',
  COMPANY_SCOPE_VIOLATION: 'COMPANY_SCOPE_VIOLATION',
  MASQUERADE_NOT_ALLOWED: 'MASQUERADE_NOT_ALLOWED',
  BLIND_ORDER_RESTRICTED: 'BLIND_ORDER_RESTRICTED',

  // Dogrulama
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',
  CONFLICT: 'CONFLICT',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',

  // Ticari
  PRODUCT_UNAVAILABLE: 'PRODUCT_UNAVAILABLE',
  PRICE_NOT_DEFINED: 'PRICE_NOT_DEFINED',
  STOCK_INSUFFICIENT: 'STOCK_INSUFFICIENT',
  CREDIT_LIMIT_EXCEEDED: 'CREDIT_LIMIT_EXCEEDED',
  OVERDUE_INVOICE_BLOCK: 'OVERDUE_INVOICE_BLOCK',
  SPENDING_LIMIT_EXCEEDED: 'SPENDING_LIMIT_EXCEEDED',
  ORDER_ALREADY_PROCESSED: 'ORDER_ALREADY_PROCESSED',
  PAYMENT_DECLINED: 'PAYMENT_DECLINED',
  PAYMENT_ALREADY_COMPLETED: 'PAYMENT_ALREADY_COMPLETED',
  POS_NOT_CONFIGURED: 'POS_NOT_CONFIGURED',

  // Sistem
  RATE_LIMITED: 'RATE_LIMITED',
  LOGO_UNAVAILABLE: 'LOGO_UNAVAILABLE',
  LOGO_SYNC_FAILED: 'LOGO_SYNC_FAILED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Tum API hatalarinin ortak govdesi. */
export interface ApiErrorBody {
  statusCode: number;
  code: ErrorCode;
  message: string;
  /** Alan bazli dogrulama hatalari: { "email": ["Geçerli bir e-posta..."] } */
  details?: Record<string, string[]>;
  /**
   * Hataya ozgu, makine tarafindan islenebilir ek veri.
   * Ornek: STOCK_INSUFFICIENT icin `{ shortages: StockShortage[] }` - istemci
   * hangi satirin sorunlu oldugunu isaretleyebilsin diye. Serbest metin mesaji
   * ayristirmak zorunda kalmaz.
   */
  context?: Record<string, unknown>;
  /** Destek talebi acilirken referans verilecek istek kimligi. */
  requestId: string;
  timestamp: string;
}

/** Kullaniciya gosterilecek varsayilan Turkce mesajlar. */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  INVALID_CREDENTIALS: 'E-posta veya şifre hatalı.',
  ACCOUNT_LOCKED:
    'Çok sayıda başarısız giriş nedeniyle hesabınız geçici olarak kilitlendi. Lütfen daha sonra tekrar deneyin.',
  ACCOUNT_SUSPENDED: 'Hesabınız askıya alınmıştır. Lütfen yetkilinizle görüşün.',
  ACCOUNT_INVITED_NOT_ACTIVE:
    'Hesabınız henüz aktifleştirilmemiş. Davet e-postanızdaki bağlantıyı kullanın.',
  MFA_REQUIRED: 'İki adımlı doğrulama gereklidir.',
  MFA_INVALID_CODE: 'Doğrulama kodu hatalı.',
  MFA_CHALLENGE_EXPIRED: 'Doğrulama süresi doldu. Lütfen tekrar giriş yapın.',
  MFA_ALREADY_ENROLLED: 'İki adımlı doğrulama zaten tanımlı.',
  MFA_NOT_ENROLLED: 'İki adımlı doğrulama tanımlı değil.',
  SESSION_EXPIRED: 'Oturumunuzun süresi doldu. Lütfen tekrar giriş yapın.',
  SESSION_REVOKED: 'Oturumunuz sonlandırıldı.',
  REFRESH_TOKEN_INVALID: 'Oturum bilgisi geçersiz. Lütfen tekrar giriş yapın.',
  REFRESH_TOKEN_REUSED:
    'Güvenlik nedeniyle tüm oturumlarınız sonlandırıldı. Lütfen tekrar giriş yapın.',
  FORBIDDEN: 'Bu işlem için yetkiniz bulunmamaktadır.',
  INSUFFICIENT_PERMISSION: 'Bu işlem için yetkiniz bulunmamaktadır.',
  IP_NOT_WHITELISTED:
    'Bulunduğunuz IP adresi yönetim paneline erişim için yetkilendirilmemiştir.',
  COMPANY_SCOPE_VIOLATION: 'Bu işletme üzerinde işlem yapma yetkiniz bulunmamaktadır.',
  MASQUERADE_NOT_ALLOWED: 'Bu işletme adına işlem yapamazsınız.',
  BLIND_ORDER_RESTRICTED: 'Bu bilgiye erişim yetkiniz bulunmamaktadır.',
  VALIDATION_FAILED: 'Gönderilen bilgiler geçersiz.',
  RESOURCE_NOT_FOUND: 'Kayıt bulunamadı.',
  CONFLICT: 'İşlem mevcut durumla çakışıyor.',
  IDEMPOTENCY_KEY_REUSED: 'Bu istek daha önce işlenmiş.',
  PRODUCT_UNAVAILABLE: 'Ürün şu anda sipariş verilebilir durumda değil.',
  PRICE_NOT_DEFINED:
    'Bu ürün için tarafınıza tanımlı bir fiyat bulunamadı. Lütfen satış temsilcinizle görüşün.',
  STOCK_INSUFFICIENT: 'Seçtiğiniz üründe yeterli stok bulunmamaktadır.',
  CREDIT_LIMIT_EXCEEDED:
    'Açık hesap kredi limitinizi aşıyorsunuz. Lütfen kredi kartı ile ödeme yapın veya bakiyenizi kapatın.',
  OVERDUE_INVOICE_BLOCK:
    'Vadesi geçmiş borcunuz bulunmaktadır. Lütfen kredi kartı ile ödeme yapın veya bakiyenizi kapatın.',
  SPENDING_LIMIT_EXCEEDED: 'Sipariş tutarı tanımlı limitinizi aşıyor. Onaya gönderildi.',
  ORDER_ALREADY_PROCESSED: 'Bu sipariş daha önce işleme alınmış.',
  PAYMENT_DECLINED: 'Ödeme bankanız tarafından onaylanmadı.',
  PAYMENT_ALREADY_COMPLETED: 'Bu ödeme daha önce tamamlanmış.',
  POS_NOT_CONFIGURED: 'Kart ile ödeme şu anda kullanılamıyor.',
  RATE_LIMITED: 'Çok fazla istek gönderdiniz. Lütfen kısa bir süre sonra tekrar deneyin.',
  LOGO_UNAVAILABLE:
    'Muhasebe sistemine şu anda ulaşılamıyor. Siparişiniz kuyruğa alındı, bağlantı sağlandığında otomatik iletilecektir.',
  LOGO_SYNC_FAILED: 'Muhasebe sistemine aktarım sırasında hata oluştu.',
  INTERNAL_ERROR: 'Beklenmeyen bir hata oluştu. Lütfen tekrar deneyin.',
};
