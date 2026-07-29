'use client';

import { Bell, LogOut, Menu, Moon, Search, Store, Sun } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth-store';

export function Topbar({ onMenuClick }: { onMenuClick: () => void }) {
  const router = useRouter();
  const { user, activeShopId, setActiveShop, logout } = useAuthStore();
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [shopMenuOpen, setShopMenuOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');

  useEffect(() => {
    const stored = window.localStorage.getItem('intoto.theme');
    if (stored === 'dark' || stored === 'light') {
      setTheme(stored);
      return;
    }
    setTheme(window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  }, []);

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    // Stamped on <html> so the CSS theme scope wins over the OS media query.
    document.documentElement.setAttribute('data-theme', next);
    window.localStorage.setItem('intoto.theme', next);
  }

  const activeShop = user?.shops.find((shop) => shop.id === activeShopId);
  // An empty shop list means org-wide access, so "All shops" is a real choice.
  const canSeeAllShops = (user?.shops.length ?? 0) !== 1;

  return (
    <header className="glass sticky top-0 z-30 flex h-16 items-center gap-3 rounded-b-2xl px-4">
      <button
        onClick={onMenuClick}
        className="rounded-lg p-2 text-[var(--text-secondary)] hover:bg-[var(--glass-bg)] lg:hidden"
        aria-label="Open navigation"
      >
        <Menu className="h-5 w-5" />
      </button>

      {/*
        Routes to the product catalogue with the term applied. A true cross-entity
        search needs a server-side endpoint spanning products, invoices and customers;
        until that exists this searches the one place it can actually answer, and the
        placeholder says so rather than implying more than it does.
      */}
      <form
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          const term = searchTerm.trim();
          if (term) router.push(`/products?search=${encodeURIComponent(term)}`);
        }}
        className="relative hidden max-w-md flex-1 sm:block"
      >
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]"
          aria-hidden
        />
        <input
          type="search"
          value={searchTerm}
          onChange={(event) => setSearchTerm(event.target.value)}
          placeholder="Search products by name, SKU or barcode…"
          aria-label="Search products"
          className="h-10 w-full rounded-xl border border-[var(--glass-ring)] bg-[var(--glass-bg)] pl-10 pr-3 text-sm placeholder:text-[var(--text-muted)] focus:border-[var(--color-brand-400)] focus:outline-none focus:ring-2 focus:ring-[var(--color-brand-500)]/20"
        />
      </form>

      <div className="ml-auto flex items-center gap-1.5">
        {/* Shop switcher — the control that makes multi-branch usable */}
        {user && user.shops.length > 0 && (
          <div className="relative">
            <button
              onClick={() => setShopMenuOpen((open) => !open)}
              aria-expanded={shopMenuOpen}
              aria-haspopup="menu"
              className="flex h-10 items-center gap-2 rounded-xl border border-[var(--glass-ring)] bg-[var(--glass-bg)] px-3 text-sm font-medium transition-colors hover:bg-[var(--glass-bg-strong)]"
            >
              <Store className="h-4 w-4 text-[var(--color-brand-500)]" aria-hidden />
              <span className="hidden max-w-32 truncate md:inline">
                {activeShop?.name ?? 'All shops'}
              </span>
            </button>

            {shopMenuOpen && (
              <>
                <div
                  className="fixed inset-0 z-10"
                  onClick={() => setShopMenuOpen(false)}
                  aria-hidden
                />
                <div
                  role="menu"
                  className="glass-strong absolute right-0 z-20 mt-2 w-60 rounded-xl p-1.5"
                >
                  {canSeeAllShops && (
                    <button
                      role="menuitem"
                      onClick={() => {
                        setActiveShop(null);
                        setShopMenuOpen(false);
                      }}
                      className={cn(
                        'w-full rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-[var(--glass-bg)]',
                        !activeShopId && 'font-medium text-[var(--color-brand-600)]',
                      )}
                    >
                      All shops
                    </button>
                  )}
                  {user.shops.map((shop) => (
                    <button
                      key={shop.id}
                      role="menuitem"
                      onClick={() => {
                        setActiveShop(shop.id);
                        setShopMenuOpen(false);
                      }}
                      className={cn(
                        'w-full rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-[var(--glass-bg)]',
                        activeShopId === shop.id && 'font-medium text-[var(--color-brand-600)]',
                      )}
                    >
                      <span className="block truncate">{shop.name}</span>
                      <span className="block text-xs text-[var(--text-muted)]">{shop.code}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        <Button variant="ghost" size="icon" aria-label="Notifications" className="relative">
          <Bell className="h-[18px] w-[18px]" />
          <span
            className="absolute right-2 top-2 h-2 w-2 rounded-full bg-[var(--status-critical)]"
            aria-label="Unread notifications"
          />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          onClick={toggleTheme}
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
        >
          {theme === 'dark' ? <Sun className="h-[18px] w-[18px]" /> : <Moon className="h-[18px] w-[18px]" />}
        </Button>

        <div className="mx-1 hidden h-8 w-px bg-[var(--glass-ring)] sm:block" />

        <div className="hidden items-center gap-2.5 sm:flex">
          <div className="grid h-9 w-9 place-items-center rounded-full bg-gradient-to-br from-[var(--color-brand-400)] to-[var(--color-brand-600)] text-sm font-semibold text-white">
            {user?.name.charAt(0).toUpperCase() ?? '?'}
          </div>
          <div className="hidden lg:block">
            <p className="text-sm font-medium leading-tight">{user?.name}</p>
            <p className="text-[11px] leading-tight text-[var(--text-muted)]">
              {user?.roles.join(', ')}
            </p>
          </div>
        </div>

        <Button variant="ghost" size="icon" onClick={() => void logout()} aria-label="Sign out">
          <LogOut className="h-[18px] w-[18px]" />
        </Button>
      </div>
    </header>
  );
}
