/**
 * ToptanPortal - Kimlik Dogrulama Sozlesmeleri (Zod)
 *
 * Bu semalar hem API tarafinda ValidationPipe olarak, hem Web tarafinda form
 * dogrulamasinda kullanilir. Tek kaynak = tek davranis.
 */

import { z } from 'zod';
import { UserRole } from './roles';
import { Permission } from './permissions';

/** Sifre politikasi: min 10 karakter, buyuk + kucuk + rakam zorunlu. */
export const passwordSchema = z
  .string()
  .min(10, 'Şifre en az 10 karakter olmalıdır.')
  .max(128, 'Şifre en fazla 128 karakter olabilir.')
  .refine((v) => /[a-zçğıöşü]/.test(v), 'Şifre en az bir küçük harf içermelidir.')
  .refine((v) => /[A-ZÇĞIİÖŞÜ]/.test(v), 'Şifre en az bir büyük harf içermelidir.')
  .refine((v) => /[0-9]/.test(v), 'Şifre en az bir rakam içermelidir.');

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(5, 'E-posta adresi geçersiz.')
  .max(254, 'E-posta adresi çok uzun.')
  .email('Geçerli bir e-posta adresi giriniz.');

/** iOS/Web istemci cihaz kimligi - oturum baglama ve guvenilir cihaz icin. */
export const deviceInfoSchema = z.object({
  deviceId: z.string().min(8).max(128),
  deviceName: z.string().trim().min(1).max(80),
  platform: z.enum(['IOS', 'WEB', 'ANDROID']),
  appVersion: z.string().trim().max(32).optional(),
  osVersion: z.string().trim().max(32).optional(),
});

export type DeviceInfo = z.infer<typeof deviceInfoSchema>;

export const loginRequestSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Şifre zorunludur.').max(128),
  device: deviceInfoSchema,
});

export type LoginRequest = z.infer<typeof loginRequestSchema>;

/** 6 haneli TOTP kodu veya 10 karakterlik kurtarma kodu. */
export const mfaVerifyRequestSchema = z.object({
  challengeToken: z.string().min(20).max(2048),
  code: z
    .string()
    .trim()
    .min(6, 'Doğrulama kodu eksik.')
    .max(20, 'Doğrulama kodu geçersiz.')
    .regex(/^[A-Za-z0-9-]+$/, 'Doğrulama kodu geçersiz karakter içeriyor.'),
  trustDevice: z.boolean().default(false),
  device: deviceInfoSchema,
});

export type MfaVerifyRequest = z.infer<typeof mfaVerifyRequestSchema>;

/** Zorunlu 2FA kaydinin baslatilmasi (giris akisi icinde). */
export const mfaEnrollStartSchema = z.object({
  challengeToken: z.string().min(20).max(2048),
});

export type MfaEnrollStartRequest = z.infer<typeof mfaEnrollStartSchema>;

export const mfaEnrollConfirmSchema = z.object({
  /** Kayit baslatildiginda donen kisa omurlu jeton. */
  enrollmentToken: z.string().min(20).max(2048),
  code: z.string().trim().length(6, 'Doğrulama kodu 6 haneli olmalıdır.').regex(/^\d{6}$/),
  device: deviceInfoSchema,
});

export type MfaEnrollConfirmRequest = z.infer<typeof mfaEnrollConfirmSchema>;

/** Oturum acmis kullanicinin gonullu 2FA kaydini onaylamasi. */
export const mfaSetupConfirmSchema = z.object({
  code: z.string().trim().length(6, 'Doğrulama kodu 6 haneli olmalıdır.').regex(/^\d{6}$/),
});

export type MfaSetupConfirmRequest = z.infer<typeof mfaSetupConfirmSchema>;

export const refreshRequestSchema = z.object({
  refreshToken: z.string().min(32).max(512),
  device: deviceInfoSchema,
});

export type RefreshRequest = z.infer<typeof refreshRequestSchema>;

export const logoutRequestSchema = z.object({
  refreshToken: z.string().min(32).max(512).optional(),
  allDevices: z.boolean().default(false),
});

export type LogoutRequest = z.infer<typeof logoutRequestSchema>;

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(128),
    newPassword: passwordSchema,
  })
  .refine((v) => v.currentPassword !== v.newPassword, {
    message: 'Yeni şifre mevcut şifre ile aynı olamaz.',
    path: ['newPassword'],
  });

export type ChangePasswordRequest = z.infer<typeof changePasswordSchema>;

/**
 * Zorunlu sifre degisikligi (ilk giris / yonetici sifirlamasi).
 * Kullanici sifresini bu adimda degistirmeden oturum acamaz.
 */
export const forcedPasswordChangeSchema = z.object({
  challengeToken: z.string().min(20).max(2048),
  newPassword: passwordSchema,
  device: deviceInfoSchema,
});

export type ForcedPasswordChangeRequest = z.infer<typeof forcedPasswordChangeSchema>;

export const startMasqueradeSchema = z.object({
  companyId: z.string().uuid('Geçersiz işletme kimliği.'),
  reason: z.string().trim().min(3, 'Gerekçe zorunludur.').max(280),
});

export type StartMasqueradeRequest = z.infer<typeof startMasqueradeSchema>;

// ---------------------------------------------------------------------------
// Yanit sozlesmeleri
// ---------------------------------------------------------------------------

export const LoginOutcome = {
  SUCCESS: 'SUCCESS',
  MFA_REQUIRED: 'MFA_REQUIRED',
  MFA_ENROLLMENT_REQUIRED: 'MFA_ENROLLMENT_REQUIRED',
  PASSWORD_CHANGE_REQUIRED: 'PASSWORD_CHANGE_REQUIRED',
} as const;

export type LoginOutcome = (typeof LoginOutcome)[keyof typeof LoginOutcome];

export const sessionUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  fullName: z.string(),
  role: z.nativeEnum(UserRole),
  roleLabel: z.string(),
  permissions: z.array(z.nativeEnum(Permission)),
  tenantId: z.string().uuid(),
  companyId: z.string().uuid().nullable(),
  companyTitle: z.string().nullable(),
  /** true ise istemci TUM parasal alanlari gizlemek zorundadir. */
  blindOrderMode: z.boolean(),
  mfaEnrolled: z.boolean(),
  primaryPlatform: z.enum(['WEB', 'IOS', 'BOTH']),
  /** Plasiyer baska bir cari adina islem yapiyorsa dolu gelir. */
  masqueradingAs: z
    .object({
      companyId: z.string().uuid(),
      companyTitle: z.string(),
      startedAt: z.string(),
    })
    .nullable(),
});

export type SessionUser = z.infer<typeof sessionUserSchema>;

export const tokenPairSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  tokenType: z.literal('Bearer'),
  expiresIn: z.number().int().positive(),
});

export type TokenPair = z.infer<typeof tokenPairSchema>;

export const loginResponseSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal(LoginOutcome.SUCCESS),
    tokens: tokenPairSchema,
    user: sessionUserSchema,
  }),
  z.object({
    outcome: z.literal(LoginOutcome.MFA_REQUIRED),
    challengeToken: z.string(),
    method: z.enum(['TOTP', 'SMS']),
    maskedPhone: z.string().nullable(),
    expiresIn: z.number().int().positive(),
  }),
  z.object({
    outcome: z.literal(LoginOutcome.MFA_ENROLLMENT_REQUIRED),
    challengeToken: z.string(),
    expiresIn: z.number().int().positive(),
  }),
  z.object({
    outcome: z.literal(LoginOutcome.PASSWORD_CHANGE_REQUIRED),
    challengeToken: z.string(),
    expiresIn: z.number().int().positive(),
  }),
]);

export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const mfaEnrollStartResponseSchema = z.object({
  /** Kimlik dogrulayici uygulamaya elle girilebilecek anahtar. */
  secret: z.string(),
  otpauthUri: z.string(),
  qrCodeDataUrl: z.string(),
  /** Onay adiminda geri gonderilecek kisa omurlu jeton. */
  enrollmentToken: z.string(),
  expiresIn: z.number().int().positive(),
});

export type MfaEnrollStartResponse = z.infer<typeof mfaEnrollStartResponseSchema>;

/**
 * Zorunlu kayit tamamlandiginda kullanici dogrudan oturum acmis olur;
 * kurtarma kodlari YALNIZCA bu yanitta bir kez gosterilir.
 */
export const mfaEnrollConfirmResponseSchema = z.object({
  recoveryCodes: z.array(z.string()),
  tokens: tokenPairSchema,
  user: sessionUserSchema,
});

export type MfaEnrollConfirmResponse = z.infer<typeof mfaEnrollConfirmResponseSchema>;

export const mfaSetupConfirmResponseSchema = z.object({
  recoveryCodes: z.array(z.string()),
});

export type MfaSetupConfirmResponse = z.infer<typeof mfaSetupConfirmResponseSchema>;

export const activeSessionSchema = z.object({
  id: z.string().uuid(),
  deviceName: z.string(),
  platform: z.enum(['WEB', 'IOS', 'ANDROID']),
  ip: z.string(),
  city: z.string().nullable(),
  createdAt: z.string(),
  lastUsedAt: z.string(),
  current: z.boolean(),
});

export type ActiveSession = z.infer<typeof activeSessionSchema>;
