import type { UserRole } from '@toptanportal/contracts';

export const TokenType = {
  ACCESS: 'access',
  /** Sifre dogrulandi, TOTP bekleniyor. */
  MFA_CHALLENGE: 'mfa_challenge',
  /** Sifre dogrulandi, zorunlu 2FA kaydi bekleniyor. */
  MFA_ENROLLMENT: 'mfa_enrollment',
  /** Sifre dogrulandi, zorunlu sifre degisikligi bekleniyor. */
  PASSWORD_CHANGE: 'password_change',
} as const;

export type TokenType = (typeof TokenType)[keyof typeof TokenType];

export interface AccessTokenPayload {
  /** Kullanici kimligi */
  sub: string;
  /** Kiraci kimligi */
  tid: string;
  /** Kullanicinin kendi cari kimligi (toptanci tarafi roller icin null) */
  cid: string | null;
  role: UserRole;
  /** Oturum (session) kimligi - iptal kontrolu bu deger uzerinden yapilir */
  sid: string;
  /** Plasiyer bayi adina islem yapiyorsa hedef cari kimligi */
  mid: string | null;
  typ: typeof TokenType.ACCESS;
  jti: string;
  iat: number;
  exp: number;
  iss: string;
  aud: string;
}

export interface ChallengeTokenPayload {
  sub: string;
  tid: string;
  typ:
    | typeof TokenType.MFA_CHALLENGE
    | typeof TokenType.MFA_ENROLLMENT
    | typeof TokenType.PASSWORD_CHANGE;
  /** Challenge'i baslatan cihazin ozeti - jeton baska cihazda kullanilamaz */
  did: string;
  jti: string;
  iat: number;
  exp: number;
  iss: string;
  aud: string;
}

export type AnyTokenPayload = AccessTokenPayload | ChallengeTokenPayload;

export function isAccessTokenPayload(
  payload: AnyTokenPayload,
): payload is AccessTokenPayload {
  return payload.typ === TokenType.ACCESS;
}
