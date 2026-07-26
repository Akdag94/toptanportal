/**
 * ToptanPortal - Cari Hesap Aritmetigi
 *
 * Yaslandirma ve tahsilat dagitimi burada SAF fonksiyon olarak durur: veritabani
 * veya istek baglami bilmez. Sebep, bu iki hesabin ticari olarak tartisilan
 * yerler olmasidir - "vadesi bugun dolan fatura gecikmis sayilir mi", "tahsilat
 * once hangi faturayi kapatir" gibi sorularin cevabi testle kilitlenir.
 *
 * Tutarlar Prisma.Decimal ile tasinir; kurus farki uretmemek icin hicbir adimda
 * JavaScript `number` aritmetigine dusulmez.
 */

import { AGING_BUCKETS, type AgingBucketKey } from '@toptanportal/contracts';

import { Decimal, money } from '../pricing/pricing.types';

/** Yaslandirma ve dagitim icin gereken asgari belge alanlari. */
export interface OpenDocument {
  id: string;
  dueDate: Date | null;
  /** Belgenin kapanmamis kismi. Daima pozitiftir. */
  openAmount: Decimal;
  /** FIFO sirasi icin - vadesi olmayan belgede belge tarihi kullanilir. */
  entryDate: Date;
}

const MS_PER_DAY = 86_400_000;

/**
 * Gecikme gunu. Vade gunu HENUZ GECIKME DEGILDIR: vadesi bugun olan fatura
 * icin 0 doner, ertesi gun 1 olur. Gun farki UTC gun basina gore alinir;
 * yaz saati gecisi olan kirici bir gunde bile fark tam sayi kalir.
 */
export function overdueDays(dueDate: Date | null, today: Date): number {
  if (!dueDate) return 0;

  const diff = utcMidnight(today) - utcMidnight(dueDate);
  if (diff <= 0) return 0;

  return Math.floor(diff / MS_PER_DAY);
}

function utcMidnight(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

export interface AgingResult {
  buckets: { key: AgingBucketKey; label: string; amount: Decimal; documentCount: number }[];
  totalOpen: Decimal;
  totalOverdue: Decimal;
  oldestOverdueDays: number;
}

/**
 * Acik belgeleri gecikme kovalarina dagitir.
 * Vadesi tanimsiz belge (dekont, devir) VADESI GELMEMIS sayilir - aksi halde
 * vade girilmemis her kayit 90+ kovasina duser ve rapor okunamaz hale gelir.
 */
export function buildAging(documents: readonly OpenDocument[], today: Date): AgingResult {
  const buckets = AGING_BUCKETS.map((definition) => ({
    key: definition.key,
    label: definition.label,
    amount: new Decimal(0),
    documentCount: 0,
  }));

  let totalOpen = new Decimal(0);
  let totalOverdue = new Decimal(0);
  let oldestOverdueDays = 0;

  for (const document of documents) {
    if (document.openAmount.lessThanOrEqualTo(0)) continue;

    const days = overdueDays(document.dueDate, today);
    const bucket = buckets[bucketIndexFor(days)] ?? buckets[buckets.length - 1];

    if (!bucket) continue;

    bucket.amount = bucket.amount.plus(document.openAmount);
    bucket.documentCount += 1;

    totalOpen = totalOpen.plus(document.openAmount);

    if (days > 0) {
      totalOverdue = totalOverdue.plus(document.openAmount);
      oldestOverdueDays = Math.max(oldestOverdueDays, days);
    }
  }

  return {
    buckets: buckets.map((bucket) => ({ ...bucket, amount: money(bucket.amount) })),
    totalOpen: money(totalOpen),
    totalOverdue: money(totalOverdue),
    oldestOverdueDays,
  };
}

function bucketIndexFor(days: number): number {
  const index = AGING_BUCKETS.findIndex(
    (bucket) =>
      days >= (bucket.minDays ?? Number.NEGATIVE_INFINITY) &&
      days <= (bucket.maxDays ?? Number.POSITIVE_INFINITY),
  );

  // Kovalar 0'dan sonsuza kesintisiz tanimlidir; buraya dusulmesi tanim
  // tablosunun bozuldugu anlamina gelir.
  return index >= 0 ? index : AGING_BUCKETS.length - 1;
}

export interface Allocation {
  entryId: string;
  amount: Decimal;
}

export interface AllocationResult {
  allocations: Allocation[];
  /** Hicbir belgeye dagitilamayan kisim - cari hesapta avans olarak kalir. */
  unallocated: Decimal;
}

/**
 * Tahsilati en eski belgeden baslayarak dagitir (FIFO).
 *
 * Siralama once VADE, vadesi yoksa belge tarihi uzerinden yapilir: muhasebe
 * uygulamasinda kapatma onceligi vadeye gore belirlenir, belgenin duzenlenme
 * tarihine gore degil. Esitlikte belge kimligi ile kararli siralama saglanir -
 * ayni tahsilat iki kez calistirilirsa ayni dagitimi uretir.
 */
export function allocateFifo(
  documents: readonly OpenDocument[],
  amount: Decimal,
): AllocationResult {
  const ordered = [...documents]
    .filter((document) => document.openAmount.greaterThan(0))
    .sort(compareByDueDate);

  const allocations: Allocation[] = [];
  let remaining = money(amount);

  for (const document of ordered) {
    if (remaining.lessThanOrEqualTo(0)) break;

    const applied = Decimal.min(remaining, document.openAmount);
    allocations.push({ entryId: document.id, amount: money(applied) });
    remaining = remaining.minus(applied);
  }

  return { allocations, unallocated: money(remaining) };
}

function compareByDueDate(left: OpenDocument, right: OpenDocument): number {
  const leftDate = (left.dueDate ?? left.entryDate).getTime();
  const rightDate = (right.dueDate ?? right.entryDate).getTime();

  if (leftDate !== rightDate) return leftDate - rightDate;

  return left.id.localeCompare(right.id);
}
