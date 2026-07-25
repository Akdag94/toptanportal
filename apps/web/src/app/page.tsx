'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

import { useSession } from '../lib/session-context';

export default function RootPage() {
  const { user, loading } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    router.replace(user ? '/panel' : '/giris');
  }, [user, loading, router]);

  return <div className="yukleniyor">Yükleniyor…</div>;
}
