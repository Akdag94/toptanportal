/**
 * ToptanPortal - Zamanlanmis Gorev Kilidi
 *
 * API birden fazla ornekte calisir. Her ornek kendi zamanlayicisini kurar;
 * kilit olmadan ayni gorev es zamanli calisir. Stok iadesi gibi bir gorevde
 * bu, ayni rezervasyonun iki kez dusulmesi demektir.
 *
 * Kilit Redis'te `SET key value NX EX` ile alinir. Serbest birakma, kilidi
 * gercekten TUTAN ornek tarafindan yapilmalidir: gorev kilit suresinden uzun
 * surerse kilit dogal olarak duser, baska bir ornek alir; ilk ornek isini
 * bitirdiginde artik KENDISININ olmayan kilidi silmemelidir. Bu yuzden silme
 * islemi Lua ile "deger esitse sil" seklinde atomik yapilir.
 *
 * Redis erisilemezse gorev CALISTIRILMAZ. Bakim gorevleri gecikebilir; ayni
 * anda iki kez calismalari ise veri bozar.
 */

import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { RedisService } from '../common/redis/redis.service';

const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

@Injectable()
export class LeaderLockService {
  private readonly logger = new Logger(LeaderLockService.name);

  constructor(private readonly redis: RedisService) {}

  /**
   * Kilidi alabilirse gorevi calistirir.
   * @param ttlSeconds Kilit omru. Gorevin en uzun surmesi beklenen suresinden
   *   uzun secilmelidir; aksi halde gorev bitmeden kilit duser.
   * @returns Gorev calistiysa sonucu, kilit alinamadiysa null.
   */
  async runExclusively<T>(
    name: string,
    ttlSeconds: number,
    task: () => Promise<T>,
  ): Promise<T | null> {
    const key = `toptanportal:lock:${name}`;
    const token = randomUUID();

    let acquired = false;

    try {
      acquired = (await this.redis.raw.set(key, token, 'EX', ttlSeconds, 'NX')) === 'OK';
    } catch (error) {
      this.logger.warn(`"${name}" görevi için kilit alınamadı: ${describe(error)}`);
      return null;
    }

    if (!acquired) {
      return null;
    }

    try {
      return await task();
    } finally {
      try {
        await this.redis.raw.eval(RELEASE_SCRIPT, 1, key, token);
      } catch (error) {
        // Kilit TTL ile zaten dusecek; gorev sonucunu bozmaya deger bir hata degil.
        this.logger.warn(`"${name}" kilidi serbest bırakılamadı: ${describe(error)}`);
      }
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
