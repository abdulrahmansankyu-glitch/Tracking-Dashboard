'use client';

import { AnimatePresence, motion } from 'framer-motion';
import {
  BarChart3, Boxes, Building2, ChevronDown, FileText, LayoutDashboard, Package,
  Receipt, Settings, ShoppingCart, Sparkles, Truck, Users, Wallet, X,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import type { Permission } from '@intoto/shared';

import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth-store';

interface NavItem {
  label: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Hidden when the user lacks this permission */
  permission?: Permission;
  children?: Array<{ label: string; href: string; permission?: Permission }>;
}

const NAVIGATION: NavItem[] = [
  { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { label: 'Point of Sale', href: '/pos', icon: ShoppingCart, permission: 'pos:create' },
  {
    label: 'Sales', href: '/sales', icon: Receipt, permission: 'sale:read',
    children: [
      { label: 'Invoices', href: '/sales/invoices' },
      { label: 'Returns', href: '/sales/returns' },
      { label: 'Customers', href: '/customers', permission: 'customer:read' },
    ],
  },
  {
    label: 'Inventory', href: '/inventory', icon: Boxes, permission: 'inventory:read',
    children: [
      { label: 'Stock', href: '/inventory/stock' },
      { label: 'Transfers', href: '/inventory/transfers' },
      { label: 'Adjustments', href: '/inventory/adjustments' },
      { label: 'Cycle Counts', href: '/inventory/cycle-counts' },
    ],
  },
  { label: 'Products', href: '/products', icon: Package, permission: 'product:read' },
  {
    label: 'Purchase', href: '/purchase', icon: Truck, permission: 'purchase_order:read',
    children: [
      { label: 'Orders', href: '/purchase/orders' },
      { label: 'Goods Receipts', href: '/purchase/receipts' },
      { label: 'Bills', href: '/purchase/bills' },
      { label: 'Suppliers', href: '/suppliers', permission: 'supplier:read' },
    ],
  },
  {
    label: 'Accounting', href: '/accounting', icon: Wallet, permission: 'accounting:read',
    children: [
      { label: 'Ledger', href: '/accounting/ledger' },
      { label: 'Journal', href: '/accounting/journal' },
      { label: 'Profit & Loss', href: '/accounting/profit-loss' },
      { label: 'Balance Sheet', href: '/accounting/balance-sheet' },
      { label: 'GST', href: '/accounting/gst', permission: 'gst:read' },
    ],
  },
  { label: 'Expenses', href: '/expenses', icon: FileText, permission: 'expense:read' },
  { label: 'Employees', href: '/employees', icon: Users, permission: 'employee:read' },
  { label: 'Shops', href: '/shops', icon: Building2, permission: 'shop:read' },
  { label: 'Reports', href: '/reports', icon: BarChart3, permission: 'report:read' },
  { label: 'AI Advisor', href: '/ai', icon: Sparkles, permission: 'ai:read' },
  { label: 'Settings', href: '/settings', icon: Settings, permission: 'settings:read' },
];

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const pathname = usePathname();
  const can = useAuthStore((state) => state.can);
  const [expanded, setExpanded] = useState<string | null>(
    NAVIGATION.find((item) => item.children && pathname.startsWith(item.href))?.label ?? null,
  );

  // Navigation is filtered by permission rather than disabled: showing a cashier a
  // greyed-out Accounting link only tells them what they are missing.
  const visible = NAVIGATION.filter((item) => !item.permission || can(item.permission));

  return (
    <>
      {/* Scrim — mobile only */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm lg:hidden"
            aria-hidden
          />
        )}
      </AnimatePresence>

      <aside
        className={cn(
          'glass-strong fixed inset-y-0 left-0 z-50 flex w-72 flex-col rounded-r-2xl',
          'transition-transform duration-300 lg:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
        aria-label="Main navigation"
      >
        <div className="flex items-center justify-between px-5 py-5">
          <Link href="/dashboard" className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-[var(--color-brand-500)] to-[var(--color-brand-700)] shadow-lg shadow-[var(--color-brand-500)]/30">
              <span className="text-lg font-bold text-white">I</span>
            </div>
            <div>
              <p className="text-sm font-bold leading-tight">Intoto</p>
              <p className="text-[11px] leading-tight text-[var(--text-muted)]">ERP System</p>
            </div>
          </Link>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-[var(--text-muted)] hover:bg-[var(--glass-bg)] lg:hidden"
            aria-label="Close navigation"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 pb-4">
          <ul className="space-y-0.5">
            {visible.map((item) => {
              const Icon = item.icon;
              const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
              const children = item.children?.filter((c) => !c.permission || can(c.permission));
              const isExpanded = expanded === item.label;

              return (
                <li key={item.label}>
                  {children?.length ? (
                    <button
                      onClick={() => setExpanded(isExpanded ? null : item.label)}
                      aria-expanded={isExpanded}
                      className={cn(
                        'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors',
                        isActive
                          ? 'bg-[var(--color-brand-500)]/12 text-[var(--color-brand-600)]'
                          : 'text-[var(--text-secondary)] hover:bg-[var(--glass-bg)] hover:text-[var(--text-primary)]',
                      )}
                    >
                      <Icon className="h-[18px] w-[18px] shrink-0" />
                      <span className="flex-1 text-left">{item.label}</span>
                      <ChevronDown
                        className={cn('h-4 w-4 transition-transform', isExpanded && 'rotate-180')}
                      />
                    </button>
                  ) : (
                    <Link
                      href={item.href}
                      onClick={onClose}
                      aria-current={isActive ? 'page' : undefined}
                      className={cn(
                        'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors',
                        isActive
                          ? 'bg-[var(--color-brand-500)]/12 text-[var(--color-brand-600)]'
                          : 'text-[var(--text-secondary)] hover:bg-[var(--glass-bg)] hover:text-[var(--text-primary)]',
                      )}
                    >
                      <Icon className="h-[18px] w-[18px] shrink-0" />
                      <span>{item.label}</span>
                    </Link>
                  )}

                  <AnimatePresence initial={false}>
                    {children?.length && isExpanded && (
                      <motion.ul
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="overflow-hidden pl-8"
                      >
                        {children.map((child) => (
                          <li key={child.href}>
                            <Link
                              href={child.href}
                              onClick={onClose}
                              aria-current={pathname === child.href ? 'page' : undefined}
                              className={cn(
                                'block rounded-lg px-3 py-2 text-[13px] transition-colors',
                                pathname === child.href
                                  ? 'font-medium text-[var(--color-brand-600)]'
                                  : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]',
                              )}
                            >
                              {child.label}
                            </Link>
                          </li>
                        ))}
                      </motion.ul>
                    )}
                  </AnimatePresence>
                </li>
              );
            })}
          </ul>
        </nav>
      </aside>
    </>
  );
}
