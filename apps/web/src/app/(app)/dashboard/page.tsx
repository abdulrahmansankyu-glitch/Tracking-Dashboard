'use client';

import {
  AlertTriangle, Banknote, Boxes, Info, PiggyBank, Receipt,
  Sparkles, TrendingDown, TrendingUp, Wallet,
} from 'lucide-react';
import dynamic from 'next/dynamic';

import { KpiTile } from '@/components/dashboard/kpi-tile';
import { SalesTrendChart } from '@/components/dashboard/sales-trend-chart';
import { TopProductsChart } from '@/components/dashboard/top-products-chart';
import { GlassCard } from '@/components/ui/glass-card';
import {
  DEMO_AI_INSIGHTS, DEMO_ALERTS, DEMO_KPIS, DEMO_SALES_TREND, DEMO_SHOPS, DEMO_TOP_PRODUCTS,
} from '@/lib/demo-data';
import { cn, formatCompact, formatNumber } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth-store';

// three.js touches `window` at import time, so the 3D view must not render on the
// server. It is also ~400KB — deferring it keeps it off the critical path.
const Shop3DView = dynamic(
  () => import('@/components/dashboard/shop-3d-view').then((m) => m.Shop3DView),
  {
    ssr: false,
    loading: () => (
      <GlassCard padding="md" className="h-full">
        <div className="h-56 animate-pulse rounded-xl bg-[var(--glass-bg)]" />
      </GlassCard>
    ),
  },
);

const KPI_ICONS = [Receipt, PiggyBank, TrendingUp, TrendingDown, Boxes, Banknote, Wallet, Banknote];

export default function DashboardPage() {
  const user = useAuthStore((state) => state.user);
  const activeShopId = useAuthStore((state) => state.activeShopId);
  const activeShop = user?.shops.find((shop) => shop.id === activeShopId);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            Good {greeting()}, {user?.name?.split(' ')[0] ?? 'there'}
          </h1>
          <p className="mt-0.5 text-sm text-[var(--text-secondary)]">
            {activeShop ? activeShop.name : 'All shops'} ·{' '}
            {new Date().toLocaleDateString('en-IN', {
              weekday: 'long',
              day: 'numeric',
              month: 'long',
              year: 'numeric',
            })}
          </p>
        </div>

        {/* Honest labelling: these figures are fixtures until the sales module lands. */}
        <span className="rounded-full border border-[var(--status-warning)]/35 bg-[var(--status-warning)]/12 px-3 py-1 text-xs font-medium text-[var(--text-secondary)]">
          Sample data — sales module pending
        </span>
      </header>

      {/* KPI row */}
      <section aria-label="Key figures">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-4">
          {DEMO_KPIS.map((kpi, index) => (
            <KpiTile
              key={kpi.label}
              {...kpi}
              icon={KPI_ICONS[index]}
              accent={(index % 8) + 1}
              index={index}
            />
          ))}
        </div>
      </section>

      {/* Charts */}
      <section className="grid gap-4 lg:grid-cols-3" aria-label="Sales analysis">
        <div className="lg:col-span-2">
          <SalesTrendChart data={DEMO_SALES_TREND} />
        </div>
        <Shop3DView shops={DEMO_SHOPS} />
      </section>

      <section className="grid gap-4 lg:grid-cols-2" aria-label="Products and alerts">
        <TopProductsChart data={DEMO_TOP_PRODUCTS} />

        <GlassCard padding="md">
          <div className="mb-4">
            <h2 className="text-base font-semibold">Inventory alerts</h2>
            <p className="text-xs text-[var(--text-muted)]">Items at or below minimum stock</p>
          </div>

          <ul className="space-y-2">
            {DEMO_ALERTS.map((alert) => {
              const tone =
                alert.severity === 'CRITICAL'
                  ? 'critical'
                  : alert.severity === 'WARNING'
                    ? 'warning'
                    : 'good';
              const Icon = alert.severity === 'INFO' ? Info : AlertTriangle;
              return (
                <li
                  key={alert.id}
                  className="flex items-center gap-3 rounded-xl border border-[var(--glass-ring)] px-3 py-2.5"
                >
                  {/* Icon + text label, never colour alone */}
                  <Icon
                    className="h-4 w-4 shrink-0"
                    style={{ color: `var(--status-${tone})` }}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{alert.product}</p>
                    <p className="text-[11px] text-[var(--text-muted)]">
                      {alert.shop} · {formatNumber(alert.currentStock)} left of{' '}
                      {formatNumber(alert.minStock)} minimum
                    </p>
                  </div>
                  <span
                    className="shrink-0 rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                    style={{
                      color: `var(--status-${tone})`,
                      backgroundColor: `color-mix(in srgb, var(--status-${tone}) 14%, transparent)`,
                    }}
                  >
                    {alert.severity}
                  </span>
                </li>
              );
            })}
          </ul>
        </GlassCard>
      </section>

      {/* AI advisor */}
      <section aria-label="AI business suggestions">
        <GlassCard padding="md">
          <div className="mb-4 flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-[var(--color-brand-500)]" aria-hidden />
            <h2 className="text-base font-semibold">AI business suggestions</h2>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            {DEMO_AI_INSIGHTS.map((insight) => {
              const tone =
                insight.severity === 'CRITICAL'
                  ? 'critical'
                  : insight.severity === 'WARNING'
                    ? 'warning'
                    : 'good';
              return (
                <article
                  key={insight.id}
                  className="rounded-xl border border-[var(--glass-ring)] p-3.5"
                >
                  <div className="mb-2 flex items-start justify-between gap-2">
                    <h3 className="text-sm font-semibold">{insight.title}</h3>
                    <span
                      className="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold"
                      style={{
                        color: `var(--status-${tone})`,
                        backgroundColor: `color-mix(in srgb, var(--status-${tone}) 14%, transparent)`,
                      }}
                    >
                      {formatCompact(insight.impactValue)}
                    </span>
                  </div>
                  <p className="text-xs leading-relaxed text-[var(--text-secondary)]">
                    {insight.summary}
                  </p>
                  {/* Confidence is shown so advice is never mistaken for fact */}
                  <p className={cn('mt-2.5 text-[11px] text-[var(--text-muted)]')}>
                    Confidence {Math.round(insight.confidence * 100)}%
                  </p>
                </article>
              );
            })}
          </div>
        </GlassCard>
      </section>
    </div>
  );
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  return 'evening';
}
