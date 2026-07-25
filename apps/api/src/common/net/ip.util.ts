/**
 * ToptanPortal - IP Adresi Yardimcilari
 *
 * Super Admin IP beyaz listesi ve hiz sinirlama, IP adresinin DOGRU tespit
 * edilmesine bagimlidir. Cloudflare arkasinda calisirken `req.ip` yuk
 * dengeleyicinin adresini gosterir; gercek istemci `CF-Connecting-IP`
 * basligindadir. Bu baslik yalnizca Cloudflare'e guvenildigi yapilandirmada
 * dikkate alinir - aksi halde saldirgan basligi taklit ederek beyaz listeyi
 * asabilir.
 */

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** IPv4 veya IPv6 adresini 16 baytlik normalize tampona cevirir. */
export function parseIpToBuffer(address: string): Buffer | null {
  const value = address.trim();
  if (value.length === 0) return null;

  // Bolge (zone) eki: fe80::1%eth0
  const zoneIndex = value.indexOf('%');
  const cleaned = zoneIndex === -1 ? value : value.slice(0, zoneIndex);

  const ipv4 = parseIpv4(cleaned);
  if (ipv4) return toMappedIpv6(ipv4);

  return parseIpv6(cleaned);
}

function parseIpv4(address: string): Buffer | null {
  const match = IPV4_PATTERN.exec(address);
  if (!match) return null;

  const bytes = Buffer.alloc(4);
  for (let i = 0; i < 4; i += 1) {
    const part = Number(match[i + 1]);
    if (!Number.isInteger(part) || part < 0 || part > 255) return null;
    bytes[i] = part;
  }
  return bytes;
}

/** IPv4 adresini ::ffff:a.b.c.d bicimine tasir; tek karsilastirma alani saglar. */
function toMappedIpv6(ipv4: Buffer): Buffer {
  const buffer = Buffer.alloc(16);
  buffer[10] = 0xff;
  buffer[11] = 0xff;
  ipv4.copy(buffer, 12);
  return buffer;
}

function parseIpv6(address: string): Buffer | null {
  if (!address.includes(':')) return null;

  const doubleColonCount = address.split('::').length - 1;
  if (doubleColonCount > 1) return null;

  let head: string[];
  let tail: string[];

  if (doubleColonCount === 1) {
    const [rawHead = '', rawTail = ''] = address.split('::');
    head = rawHead.length > 0 ? rawHead.split(':') : [];
    tail = rawTail.length > 0 ? rawTail.split(':') : [];
  } else {
    head = address.split(':');
    tail = [];
  }

  // Sondaki gomulu IPv4 (ornek: ::ffff:192.168.1.1)
  const embeddedSource = tail.length > 0 ? tail : head;
  const lastPart = embeddedSource[embeddedSource.length - 1];
  let embeddedIpv4: Buffer | null = null;

  if (lastPart !== undefined && lastPart.includes('.')) {
    embeddedIpv4 = parseIpv4(lastPart);
    if (!embeddedIpv4) return null;
    embeddedSource.pop();
  }

  const groupsFromIpv4 = embeddedIpv4 ? 2 : 0;
  const totalGroups = head.length + tail.length + groupsFromIpv4;
  if (totalGroups > 8) return null;
  if (doubleColonCount === 0 && totalGroups !== 8) return null;

  const buffer = Buffer.alloc(16);

  let offset = 0;
  for (const group of head) {
    if (!writeGroup(buffer, offset, group)) return null;
    offset += 2;
  }

  let tailOffset = 16 - groupsFromIpv4 * 2 - tail.length * 2;
  if (tailOffset < offset) return null;

  for (const group of tail) {
    if (!writeGroup(buffer, tailOffset, group)) return null;
    tailOffset += 2;
  }

  if (embeddedIpv4) {
    embeddedIpv4.copy(buffer, 12);
  }

  return buffer;
}

function writeGroup(buffer: Buffer, offset: number, group: string): boolean {
  if (group.length === 0 || group.length > 4) return false;
  if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return false;

  const value = Number.parseInt(group, 16);
  buffer.writeUInt16BE(value, offset);
  return true;
}

export interface ParsedCidr {
  network: Buffer;
  prefixLength: number;
}

/**
 * "88.240.10.0/24" veya "2a02:ff0::/32" bicimindeki CIDR ifadesini cozer.
 * Maske verilmezse tek adres (/32 veya /128) kabul edilir.
 */
export function parseCidr(cidr: string): ParsedCidr | null {
  const value = cidr.trim();
  if (value.length === 0) return null;

  const slashIndex = value.lastIndexOf('/');
  const addressPart = slashIndex === -1 ? value : value.slice(0, slashIndex);
  const maskPart = slashIndex === -1 ? null : value.slice(slashIndex + 1);

  const address = parseIpToBuffer(addressPart);
  if (!address) return null;

  const isIpv4Mapped = isIpv4MappedBuffer(address);

  let prefixLength: number;
  if (maskPart === null) {
    prefixLength = isIpv4Mapped ? 128 : 128;
  } else {
    const parsedMask = Number(maskPart);
    if (!Number.isInteger(parsedMask) || parsedMask < 0) return null;

    if (isIpv4Mapped) {
      if (parsedMask > 32) return null;
      // IPv4 maskesini eslenmis IPv6 alanina tasi
      prefixLength = 96 + parsedMask;
    } else {
      if (parsedMask > 128) return null;
      prefixLength = parsedMask;
    }
  }

  return { network: address, prefixLength };
}

function isIpv4MappedBuffer(buffer: Buffer): boolean {
  for (let i = 0; i < 10; i += 1) {
    if (buffer[i] !== 0) return false;
  }
  return buffer[10] === 0xff && buffer[11] === 0xff;
}

/** Verilen IP adresi CIDR blogunun icinde mi? */
export function isIpInCidr(address: string, cidr: string): boolean {
  const ip = parseIpToBuffer(address);
  const parsed = parseCidr(cidr);
  if (!ip || !parsed) return false;

  const { network, prefixLength } = parsed;
  const fullBytes = Math.floor(prefixLength / 8);
  const remainingBits = prefixLength % 8;

  for (let i = 0; i < fullBytes; i += 1) {
    if (ip[i] !== network[i]) return false;
  }

  if (remainingBits === 0) return true;

  const mask = 0xff << (8 - remainingBits);
  const ipByte = ip[fullBytes] ?? 0;
  const networkByte = network[fullBytes] ?? 0;

  return (ipByte & mask) === (networkByte & mask);
}

/** IP adresinin listedeki herhangi bir CIDR blogunda olup olmadigini soyler. */
export function isIpAllowed(address: string, cidrList: readonly string[]): boolean {
  return cidrList.some((cidr) => isIpInCidr(address, cidr));
}

export interface ClientNetworkInfo {
  ip: string;
  country: string | null;
  city: string | null;
}

interface HeaderBag {
  [key: string]: string | string[] | undefined;
}

function firstHeaderValue(headers: HeaderBag, name: string): string | null {
  const raw = headers[name];
  if (raw === undefined) return null;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Istemcinin gercek ag bilgisini cozer.
 *
 * @param trustCloudflare true ise CF-* basliklari otorite kabul edilir. Bu
 *        ayar YALNIZCA sunucuya dogrudan erisimin ag seviyesinde kapali oldugu
 *        (yalnizca Cloudflare IP araliklarindan gelen trafigin kabul edildigi)
 *        kurulumlarda acik birakilmalidir.
 */
export function resolveClientNetwork(
  headers: HeaderBag,
  socketAddress: string | undefined,
  trustCloudflare: boolean,
): ClientNetworkInfo {
  const fallback = normalizeAddress(socketAddress ?? '') ?? '0.0.0.0';

  if (!trustCloudflare) {
    return { ip: fallback, country: null, city: null };
  }

  const cfIp = firstHeaderValue(headers, 'cf-connecting-ip');
  const forwardedFor = firstHeaderValue(headers, 'x-forwarded-for');

  const candidate =
    cfIp ?? (forwardedFor ? (forwardedFor.split(',')[0] ?? '').trim() : null);

  const resolved = candidate ? (normalizeAddress(candidate) ?? fallback) : fallback;

  const country = firstHeaderValue(headers, 'cf-ipcountry');
  const city = firstHeaderValue(headers, 'cf-ipcity');

  return {
    ip: resolved,
    country: country && country !== 'XX' ? country.slice(0, 2).toUpperCase() : null,
    city: city ? city.slice(0, 64) : null,
  };
}

/** "::ffff:1.2.3.4" gibi eslenmis adresleri okunabilir IPv4'e indirger. */
export function normalizeAddress(address: string): string | null {
  const value = address.trim();
  if (value.length === 0) return null;

  if (value.toLowerCase().startsWith('::ffff:')) {
    const candidate = value.slice(7);
    if (IPV4_PATTERN.test(candidate)) return candidate;
  }

  return parseIpToBuffer(value) ? value : null;
}
