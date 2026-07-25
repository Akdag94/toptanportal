/**
 * Tarayici cihaz kimligi.
 *
 * Sunucu tarafinda oturum, cihaz kimligine baglanir; yenileme jetonu baska bir
 * cihazda kullanilirsa zincir iptal edilir. Kimlik kalici olmalidir, bu yuzden
 * localStorage'da tutulur. Kisisel veri icermez.
 */

import type { DeviceInfo } from '@toptanportal/contracts';

const DEVICE_ID_KEY = 'toptanportal.deviceId';

function createDeviceId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function getDeviceId(): string {
  if (typeof window === 'undefined') return 'sunucu-render';

  const existing = window.localStorage.getItem(DEVICE_ID_KEY);
  if (existing && existing.length >= 8) return existing;

  const created = createDeviceId();
  window.localStorage.setItem(DEVICE_ID_KEY, created);
  return created;
}

function detectBrowserName(userAgent: string): string {
  if (userAgent.includes('Edg/')) return 'Edge';
  if (userAgent.includes('Chrome/') && !userAgent.includes('Chromium')) return 'Chrome';
  if (userAgent.includes('Safari/') && !userAgent.includes('Chrome/')) return 'Safari';
  if (userAgent.includes('Firefox/')) return 'Firefox';
  return 'Tarayıcı';
}

function detectPlatform(userAgent: string): string {
  if (userAgent.includes('Windows')) return 'Windows';
  if (userAgent.includes('Mac OS X')) return 'macOS';
  if (userAgent.includes('Linux')) return 'Linux';
  return 'Bilinmeyen';
}

export function getDeviceInfo(): DeviceInfo {
  if (typeof window === 'undefined') {
    return {
      deviceId: 'sunucu-render',
      deviceName: 'Sunucu',
      platform: 'WEB',
    };
  }

  const userAgent = window.navigator.userAgent;

  return {
    deviceId: getDeviceId(),
    deviceName: `${detectBrowserName(userAgent)} · ${detectPlatform(userAgent)}`,
    platform: 'WEB',
    appVersion: process.env.NEXT_PUBLIC_APP_VERSION ?? '1.0.0',
  };
}
