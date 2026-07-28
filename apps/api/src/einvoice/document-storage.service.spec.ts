/**
 * e-Belge deposu testleri.
 *
 * Kilitlenen davranis: kok dizin disina cikan hicbir yol acilmaz. `xmlPath`
 * bugun yalnizca veritabanindan geliyor olabilir; yarin bir gecis betigi veya
 * entegrator yaniti besledinde, bu kontrol sunucudaki tum dosyalar ile arsiv
 * arasindaki tek duvardir.
 */

import type { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DocumentStorageService } from './document-storage.service';

function build(root: string): DocumentStorageService {
  const config = {
    getOrThrow: () => ({ EDOCUMENT_STORAGE_PATH: root }),
  } as unknown as ConfigService;

  return new DocumentStorageService(config);
}

describe('DocumentStorageService', () => {
  let root: string;
  let disari: string;
  let storage: DocumentStorageService;

  beforeAll(() => {
    const taban = mkdtempSync(join(tmpdir(), 'toptanportal-arsiv-'));
    root = join(taban, 'arsiv');
    disari = join(taban, 'gizli.txt');

    mkdirSync(join(root, '2026', '07'), { recursive: true });
    writeFileSync(join(root, '2026', '07', 'ABC2026000000431.xml'), '<Invoice/>', 'utf8');
    writeFileSync(disari, 'kok dizin disindaki dosya', 'utf8');

    storage = build(root);
  });

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('kök dizin içindeki belgeyi açar', async () => {
    const belge = await storage.open('2026/07/ABC2026000000431.xml');

    expect(belge).not.toBeNull();
    expect(belge?.sizeBytes).toBeGreaterThan(0);
    belge?.stream.destroy();
  });

  it('".." ile kök dizin dışına çıkan yolu reddeder', async () => {
    expect(await storage.open('../gizli.txt')).toBeNull();
    expect(await storage.open('2026/../../gizli.txt')).toBeNull();
    expect(await storage.open('2026/07/../../../gizli.txt')).toBeNull();
  });

  it('mutlak yolu reddeder', async () => {
    expect(await storage.open(disari)).toBeNull();
  });

  it('arşivde olmayan belgede null döner', async () => {
    expect(await storage.open('2026/07/YOK.xml')).toBeNull();
  });

  it('içeriğin SHA-256 özetini hesaplar', async () => {
    const ozet = await storage.computeHash('2026/07/ABC2026000000431.xml');

    // "<Invoice/>" icin sabit ozet - dosya degisirse test kirilir.
    expect(ozet).toHaveLength(64);
    expect(ozet).toMatch(/^[0-9a-f]{64}$/);
  });
});
