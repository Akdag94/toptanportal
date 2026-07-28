/**
 * ToptanPortal API - e-Belge Deposu
 *
 * Belgeler dosya sisteminde tutulur ve yol, veritabanindaki `xmlPath` alanindan
 * gelir. Tek isi okumaktir: bu servis belge YAZMAZ, cunku e-belgeyi ureten
 * taraf entegratordur; portal onu arsivler ve sunar.
 *
 * YOL DOGRULAMASI kritik onemdedir. `xmlPath` veritabanindan gelir ama bir gun
 * baska bir kaynaktan (entegrator yaniti, elle duzeltme, gecis betigi)
 * beslenebilir. Kok dizinin disina cikan bir yol, sunucudaki herhangi bir
 * dosyayi indirilebilir kilar - bu yuzden her okuma once koke gore cozulur ve
 * disari tasan istek reddedilir.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { isAbsolute, normalize, resolve, sep } from 'node:path';
import type { ReadStream } from 'node:fs';

import type { AppConfig } from '../config/configuration';

export interface StoredDocument {
  stream: ReadStream;
  sizeBytes: number;
}

@Injectable()
export class DocumentStorageService {
  private readonly logger = new Logger(DocumentStorageService.name);
  private readonly root: string;

  constructor(configService: ConfigService) {
    const config = configService.getOrThrow<AppConfig>('app');
    this.root = resolve(config.EDOCUMENT_STORAGE_PATH);
  }

  /**
   * Goreli yolu kok dizine gore cozer ve disari tasmadigini dogrular.
   *
   * `..` iceren bir yol normalize edildikten SONRA denetlenir; once denetleyip
   * sonra birlestirmek, `a/../../../etc/passwd` gibi bir girdiyi kacirir.
   */
  private resolveSafe(relativePath: string): string | null {
    if (isAbsolute(relativePath)) return null;

    const absolute = resolve(this.root, normalize(relativePath));

    if (absolute !== this.root && !absolute.startsWith(this.root + sep)) {
      this.logger.error(`Kök dizin dışına çıkan belge yolu reddedildi: ${relativePath}`);
      return null;
    }

    return absolute;
  }

  async open(relativePath: string): Promise<StoredDocument | null> {
    const absolute = this.resolveSafe(relativePath);
    if (absolute === null) return null;

    try {
      const bilgi = await stat(absolute);
      if (!bilgi.isFile()) return null;

      return { stream: createReadStream(absolute), sizeBytes: bilgi.size };
    } catch {
      /* Dosya arsivde yok. Bu SESSIZ gecilmez: veritabani belgenin var
         oldugunu soyluyor ama depo aksini soyluyorsa, arsivde bir tutarsizlik
         vardir ve 10 yillik saklama yukumlulugu tehlikededir. */
      this.logger.error(`Arşivde bulunamayan belge: ${relativePath}`);
      return null;
    }
  }

  /**
   * Dosyanin SHA-256 ozetini hesaplar.
   *
   * Kayitli ozetle karsilastirmak icin kullanilir: arsivdeki bir dosya sessizce
   * degistiyse (disk hatasi, yanlis geri yukleme, mudahale) indirme aninda
   * ortaya cikar. Belgeyi imzalanmis halinden farkli sunmak, hukuki degerini
   * yok eder.
   */
  async computeHash(relativePath: string): Promise<string | null> {
    const belge = await this.open(relativePath);
    if (belge === null) return null;

    return new Promise((cozumle, reddet) => {
      const ozet = createHash('sha256');
      belge.stream.on('data', (parca) => ozet.update(parca));
      belge.stream.on('end', () => cozumle(ozet.digest('hex')));
      belge.stream.on('error', reddet);
    });
  }
}
