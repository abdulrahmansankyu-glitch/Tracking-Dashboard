'use client';

import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { Sidebar } from '@/components/layout/sidebar';
import { Topbar } from '@/components/layout/topbar';
import { useAuthStore } from '@/stores/auth-store';

/**
 * Authenticated shell.
 *
 * The guard here is a convenience, not the security boundary — every API call is
 * independently authorised server-side. Bypassing this in the browser gets you an
 * empty shell that 401s on every request.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { status, hydrate } = useAuthStore();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    if (status === 'idle') void hydrate();
  }, [status, hydrate]);

  useEffect(() => {
    if (status === 'unauthenticated') router.replace('/login');
  }, [status, router]);

  if (status !== 'authenticated') {
    return (
      <div className="grid min-h-screen place-items-center">
        <Loader2 className="h-6 w-6 animate-spin text-[var(--text-muted)]" aria-label="Loading" />
      </div>
    );
  }

  return (
    <div className="min-h-screen lg:pl-72">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <Topbar onMenuClick={() => setSidebarOpen(true)} />
      <main className="p-4 sm:p-6">{children}</main>
    </div>
  );
}
