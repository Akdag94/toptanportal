'use client';

/**
 * ToptanPortal Web - Oturum Baglami
 *
 * Uygulama acilisinda saklanmis yenileme jetonu varsa sessizce oturum kurulur.
 * Jeton yoksa veya gecersizse kullanici anonim kabul edilir; yonlendirme
 * kararini sayfalar verir.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { SessionUser, TokenPair } from '@toptanportal/contracts';

import {
  authApi,
  clearTokens,
  hasStoredSession,
  onSessionChange,
  refreshSession,
  setTokens,
} from './api-client';

export interface SessionState {
  user: SessionUser | null;
  /** Ilk oturum kurulumu tamamlanana kadar true. */
  loading: boolean;
  signIn: (tokens: TokenPair, user: SessionUser) => void;
  signOut: (allDevices?: boolean) => Promise<void>;
  reload: () => Promise<void>;
}

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => onSessionChange(setUser), []);

  useEffect(() => {
    let cancelled = false;

    async function restore(): Promise<void> {
      if (!hasStoredSession()) {
        if (!cancelled) setLoading(false);
        return;
      }

      const restored = await refreshSession();

      if (cancelled) return;

      if (!restored) {
        setUser(null);
        setLoading(false);
        return;
      }

      try {
        const profile = await authApi.me();
        if (!cancelled) setUser(profile);
      } catch {
        if (!cancelled) {
          clearTokens();
          setUser(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void restore();

    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback((tokens: TokenPair, nextUser: SessionUser) => {
    setTokens(tokens);
    setUser(nextUser);
    setLoading(false);
  }, []);

  const signOut = useCallback(async (allDevices = false) => {
    try {
      await authApi.logout(allDevices);
    } catch {
      // Sunucuya ulasilamasa dahi yerel oturum kapatilir.
    } finally {
      clearTokens();
      setUser(null);
    }
  }, []);

  const reload = useCallback(async () => {
    try {
      setUser(await authApi.me());
    } catch {
      clearTokens();
      setUser(null);
    }
  }, []);

  const value = useMemo<SessionState>(
    () => ({ user, loading, signIn, signOut, reload }),
    [user, loading, signIn, signOut, reload],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const context = useContext(SessionContext);
  if (!context) {
    throw new Error('useSession yalnızca SessionProvider içinde kullanılabilir.');
  }
  return context;
}
