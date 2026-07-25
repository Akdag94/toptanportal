/**
 * ToptanPortal - Kriptografi Servisi
 *
 * Sorumluluklar:
 *  * Alan bazli sifreleme (AES-256-GCM) - KVKK Md.12 "at-rest" gerekliligi
 *  * Blind index (HMAC-SHA256) - sifreli alanda esitlik aramasi
 *  * Sifre ozetleme (Argon2id) - OWASP Password Storage Cheat Sheet
 *  * Jeton uretimi ve sabit zamanli karsilastirma
 *
 * Sifreli metin bicimi:  v1.<anahtarId>.<iv_b64>.<etiket_b64>.<sifreliMetin_b64>
 * Anahtar kimligi metne gomuludur; boylece anahtar rotasyonunda eski kayitlar
 * yeniden sifrelenmeden okunabilir.
 */

import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createHash,
  createHmac,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import * as argon2 from 'argon2';

import type { AppConfig, EncryptionKeyRing } from '../../config/configuration';

const CIPHER_ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // GCM icin onerilen 96 bit
const AUTH_TAG_LENGTH = 16;
const CIPHERTEXT_VERSION = 'v1';

/** OWASP 2024 onerisi (m=19 MiB, t=2, p=1). */
const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

@Injectable()
export class CryptoService {
  private readonly logger = new Logger(CryptoService.name);
  private readonly keyRing: EncryptionKeyRing;

  constructor(configService: ConfigService) {
    const config = configService.getOrThrow<AppConfig>('app');
    this.keyRing = config.encryption;
  }

  // -------------------------------------------------------------------------
  // Alan bazli sifreleme
  // -------------------------------------------------------------------------

  encryptField(plainText: string): string {
    const keyId = this.keyRing.activeKeyId;
    const key = this.keyRing.keys.get(keyId);

    if (!key) {
      throw new InternalServerErrorException('Aktif şifreleme anahtarı bulunamadı.');
    }

    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(CIPHER_ALGORITHM, key, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });

    const encrypted = Buffer.concat([
      cipher.update(plainText, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    return [
      CIPHERTEXT_VERSION,
      keyId,
      iv.toString('base64'),
      authTag.toString('base64'),
      encrypted.toString('base64'),
    ].join('.');
  }

  decryptField(cipherText: string): string {
    const parts = cipherText.split('.');

    if (parts.length !== 5) {
      throw new InternalServerErrorException('Şifreli alan biçimi geçersiz.');
    }

    const [version, keyId, ivB64, tagB64, payloadB64] = parts as [
      string,
      string,
      string,
      string,
      string,
    ];

    if (version !== CIPHERTEXT_VERSION) {
      throw new InternalServerErrorException(
        `Desteklenmeyen şifreleme sürümü: ${version}`,
      );
    }

    const key = this.keyRing.keys.get(keyId);
    if (!key) {
      throw new InternalServerErrorException(
        `"${keyId}" şifreleme anahtarı bu kurulumda tanımlı değil.`,
      );
    }

    try {
      const decipher = createDecipheriv(
        CIPHER_ALGORITHM,
        key,
        Buffer.from(ivB64, 'base64'),
        { authTagLength: AUTH_TAG_LENGTH },
      );
      decipher.setAuthTag(Buffer.from(tagB64, 'base64'));

      return Buffer.concat([
        decipher.update(Buffer.from(payloadB64, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Şifre çözme başarısız (anahtar: ${keyId}): ${message}`);
      throw new InternalServerErrorException('Şifreli veri çözülemedi.');
    }
  }

  /**
   * Sifreli alanda esitlik aramasi icin deterministik indeks.
   * Telefon numarasi gibi degerler once normalize edilmelidir.
   */
  blindIndex(value: string): string {
    return createHmac('sha256', this.keyRing.blindIndexKey)
      .update(value.trim().toLowerCase(), 'utf8')
      .digest('hex');
  }

  /** Telefon numarasini blind index oncesi normalize eder: sadece rakamlar. */
  normalizePhone(phone: string): string {
    const digits = phone.replace(/\D/g, '');
    // 0532... / 90532... / +90532... hepsini 90XXXXXXXXXX bicimine indirger
    if (digits.length === 10) return `90${digits}`;
    if (digits.length === 11 && digits.startsWith('0')) return `90${digits.slice(1)}`;
    return digits;
  }

  // -------------------------------------------------------------------------
  // Sifre ozetleme
  // -------------------------------------------------------------------------

  async hashPassword(plainPassword: string): Promise<string> {
    return argon2.hash(plainPassword, ARGON2_OPTIONS);
  }

  /**
   * Sifre dogrulamasi. Hatali hash formatinda dahi istisna firlatmaz; false
   * doner - boylece bozuk kayit, yanit suresi farkiyla saldirgana ipucu vermez.
   */
  async verifyPassword(hash: string, plainPassword: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plainPassword, ARGON2_OPTIONS);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Şifre doğrulaması başarısız oldu: ${message}`);
      return false;
    }
  }

  /**
   * Kullanici bulunamadiginda dahi Argon2 maliyetini odemek icin kullanilir.
   * Zamanlama farkindan kullanici sayimi (user enumeration) yapilmasini engeller.
   */
  async burnPasswordVerification(): Promise<void> {
    await argon2
      .hash(randomBytes(16).toString('hex'), ARGON2_OPTIONS)
      .catch(() => undefined);
  }

  // -------------------------------------------------------------------------
  // Jetonlar
  // -------------------------------------------------------------------------

  /** URL guvenli, kriptografik olarak guclu rastgele jeton. */
  generateToken(byteLength = 48): string {
    return randomBytes(byteLength).toString('base64url');
  }

  /** Refresh token ve cihaz kimligi gibi degerleri veritabaninda ozet olarak tutariz. */
  sha256(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }

  /**
   * 2FA kurtarma kodu: XXXX-XXXX-XX bicimi, karistirilabilir karakterler (0/O, 1/I)
   * cikarilmis alfabe.
   */
  generateRecoveryCode(): string {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = randomBytes(10);
    let raw = '';

    for (const byte of bytes) {
      raw += alphabet[byte % alphabet.length];
    }

    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 10)}`;
  }

  /** Sabit zamanli string karsilastirma - zamanlama saldirilarina karsi. */
  safeEquals(a: string, b: string): boolean {
    const bufferA = Buffer.from(a, 'utf8');
    const bufferB = Buffer.from(b, 'utf8');

    if (bufferA.length !== bufferB.length) {
      // Uzunluk farkini da sabit zamanda ele almak icin sahte karsilastirma yap
      timingSafeEqual(bufferA, bufferA);
      return false;
    }

    return timingSafeEqual(bufferA, bufferB);
  }
}
