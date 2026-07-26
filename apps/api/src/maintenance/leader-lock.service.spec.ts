/**
 * Zamanlanmis gorev kilidinin testleri.
 *
 * Kilit yanlis calisirsa stok iadesi iki kez yapilir ve depoda olmayan mal
 * satilabilir hale gelir. Bu yuzden "kilit alinamadiginda gorev CALISMAZ"
 * kurali test altindadir.
 */

import type { RedisService } from '../common/redis/redis.service';
import { LeaderLockService } from './leader-lock.service';

function buildRedis(options: { acquired?: boolean; setThrows?: boolean; evalThrows?: boolean } = {}) {
  const set = jest.fn().mockImplementation(() => {
    if (options.setThrows) return Promise.reject(new Error('Redis erişilemiyor'));
    return Promise.resolve(options.acquired === false ? null : 'OK');
  });

  const evalFn = jest.fn().mockImplementation(() => {
    if (options.evalThrows) return Promise.reject(new Error('Redis erişilemiyor'));
    return Promise.resolve(1);
  });

  return {
    service: { raw: { set, eval: evalFn } } as unknown as RedisService,
    set,
    eval: evalFn,
  };
}

describe('LeaderLockService', () => {
  it('kilidi alabilirse görevi çalıştırır ve sonucu döner', async () => {
    const redis = buildRedis({ acquired: true });
    const service = new LeaderLockService(redis.service);

    const result = await service.runExclusively('is', 60, () => Promise.resolve(42));

    expect(result).toBe(42);
    expect(redis.set).toHaveBeenCalledWith('toptanportal:lock:is', expect.any(String), 'EX', 60, 'NX');
  });

  it('kilit başka bir örnekte ise görevi ÇALIŞTIRMAZ', async () => {
    const redis = buildRedis({ acquired: false });
    const service = new LeaderLockService(redis.service);
    const task = jest.fn().mockResolvedValue('calisti');

    const result = await service.runExclusively('is', 60, task);

    expect(result).toBeNull();
    expect(task).not.toHaveBeenCalled();
  });

  it('Redis erişilemiyorsa görevi ÇALIŞTIRMAZ — gecikme, çift çalıştırmaya yeğdir', async () => {
    const redis = buildRedis({ setThrows: true });
    const service = new LeaderLockService(redis.service);
    const task = jest.fn().mockResolvedValue('calisti');

    const result = await service.runExclusively('is', 60, task);

    expect(result).toBeNull();
    expect(task).not.toHaveBeenCalled();
  });

  it('görev hata fırlatsa bile kilidi serbest bırakır', async () => {
    const redis = buildRedis({ acquired: true });
    const service = new LeaderLockService(redis.service);

    await expect(
      service.runExclusively('is', 60, () => Promise.reject(new Error('gorev patladi'))),
    ).rejects.toThrow('gorev patladi');

    expect(redis.eval).toHaveBeenCalledTimes(1);
  });

  it('kilidi yalnızca kendi jetonuyla siler — başkasının kilidini düşürmez', async () => {
    const redis = buildRedis({ acquired: true });
    const service = new LeaderLockService(redis.service);

    await service.runExclusively('is', 60, () => Promise.resolve(null));

    const setToken = redis.set.mock.calls[0]?.[1] as string;
    const evalArgs = redis.eval.mock.calls[0] as unknown[];

    expect(evalArgs[1]).toBe(1);
    expect(evalArgs[2]).toBe('toptanportal:lock:is');
    expect(evalArgs[3]).toBe(setToken);
    expect(String(evalArgs[0])).toContain("redis.call('GET', KEYS[1]) == ARGV[1]");
  });

  it('kilit serbest bırakılamazsa görev sonucunu bozmaz', async () => {
    const redis = buildRedis({ acquired: true, evalThrows: true });
    const service = new LeaderLockService(redis.service);

    await expect(service.runExclusively('is', 60, () => Promise.resolve('tamam'))).resolves.toBe(
      'tamam',
    );
  });
});
