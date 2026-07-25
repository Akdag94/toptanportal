/**
 * ToptanPortal - TOTP (Zaman Tabanli Tek Kullanimlik Sifre) Servisi
 *
 * RFC 6238 uyumlu; Google Authenticator, Microsoft Authenticator ve iOS
 * Sifreler uygulamasi ile calisir.
 *
 * Guvenlik notlari:
 *  * Secret veritabaninda AES-256-GCM ile sifreli tutulur.
 *  * Dogrulama penceresi +/-1 adimdir (30 sn) - cihaz saat kaymasina tolerans
 *    saglar, ancak kaba kuvvet penceresini genisletmez.
 *  * Basariyla kullanilan her kod Redis'te isaretlenir; ayni kod pencere
 *    icinde ikinci kez kullanilamaz (replay koruması).
 */

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { authenticator } from 'otplib';
import * as QRCode from 'qrcode';

import type { AppConfig } from '../config/configuration';
import { CryptoService } from '../common/crypto/crypto.service';
import { RedisService } from '../common/redis/redis.service';

const TOTP_STEP_SECONDS = 30;
const TOTP_WINDOW = 1;

export interface TotpEnrollment {
  secret: string;
  otpauthUri: string;
  qrCodeDataUrl: string;
}

@Injectable()
export class TotpService {
  private readonly issuer: string;

  constructor(
    private readonly crypto: CryptoService,
    private readonly redis: RedisService,
    configService: ConfigService,
  ) {
    const config = configService.getOrThrow<AppConfig>('app');
    this.issuer = config.TOTP_ISSUER;

    authenticator.options = {
      step: TOTP_STEP_SECONDS,
      window: TOTP_WINDOW,
      digits: 6,
    };
  }

  /** Yeni bir secret ve QR kodu uretir. Secret henuz kaydedilmez. */
  async createEnrollment(accountLabel: string): Promise<TotpEnrollment> {
    const secret = authenticator.generateSecret(20);
    const otpauthUri = authenticator.keyuri(accountLabel, this.issuer, secret);
    const qrCodeDataUrl = await QRCode.toDataURL(otpauthUri, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 240,
    });

    return { secret, otpauthUri, qrCodeDataUrl };
  }

  encryptSecret(secret: string): string {
    return this.crypto.encryptField(secret);
  }

  /**
   * Kodu dogrular ve pencere icinde tekrar kullanilmasini engeller.
   * @param userId Replay isaretcisinin kapsami
   * @param encryptedSecret Veritabanindaki sifreli secret
   */
  async verifyCode(
    userId: string,
    encryptedSecret: string,
    code: string,
  ): Promise<boolean> {
    const normalized = code.replace(/\s/g, '');
    if (!/^\d{6}$/.test(normalized)) return false;

    let secret: string;
    try {
      secret = this.crypto.decryptField(encryptedSecret);
    } catch {
      return false;
    }

    const isValid = authenticator.verify({ token: normalized, secret });
    if (!isValid) return false;

    // Ayni kod, gecerlilik penceresi boyunca yalnizca bir kez kullanilabilir.
    const replayKey = `totp:used:${userId}:${normalized}`;
    const firstUse = await this.redis.consumeOnce(
      replayKey,
      TOTP_STEP_SECONDS * (TOTP_WINDOW * 2 + 1),
    );

    return firstUse;
  }

  /** Kayit adiminda kullanilir; secret henuz veritabaninda olmadigi icin duz gelir. */
  verifyPlainSecret(secret: string, code: string): boolean {
    const normalized = code.replace(/\s/g, '');
    if (!/^\d{6}$/.test(normalized)) return false;
    return authenticator.verify({ token: normalized, secret });
  }
}
