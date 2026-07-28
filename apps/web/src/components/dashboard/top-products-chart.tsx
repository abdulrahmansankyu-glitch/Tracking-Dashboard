'use client';

import { GlassCard } from '@/components/ui/glass-card';
import { formatCompact, formatNumber } from '@/lib/utils';
import type { TopProduct } from '@/lib/demo-data';

/**
 * Best sellers by revenue.
 *
 * Horizontal bars, built in plain HTML rather than a chart library: the category is a
 * long text label, ranking is the whole point, and every bar is directly labelled — so
 * a rendered chart would add weight without adding information. One hue throughout,
 * because the bars are one measure ranked, not eight different things.
 */
export function TopProductsChart({ data }: { data: TopProduct[] }) {
  const max = Math.max(...data.map((product) => product.revenue), 1);

  return (
    <GlassCard padding="md" className="h-full">
      <div className="mb-4">
        <h2 className="text-base font-semibold">Top selling products</h2>
        <p className="text-xs text-[var(--text-muted)]">By revenue, this month</p>
      </div>

      <ul className="space-y-3.5">
        {data.map((product) => (
          <li key={product.name}>
            <div className="mb-1.5 flex items-baseline justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{product.name}</p>
                <p className="text-[11px] text-[var(--text-muted)]">
                  {product.category} · {formatNumber(product.quantity)} units
                </p>
              </div>
              <span className="tabular shrink-0 text-sm font-semibold">
                {formatCompact(product.revenue)}
              </span>
            </div>

            {/* Track + fill. The fill is anchored to the baseline with rounded data-end
                only, so the bar reads as growing from zero rather than floating. */}
            <div
              className="h-2 w-full overflow-hidden rounded-full bg-[var(--viz-grid)]"
              role="img"
              aria-label={`${product.name}: ${formatCompact(product.revenue)}`}
            >
              <div
                className="h-full rounded-r-full transition-[width] duration-500"
                style={{
                  width: `${Math.max(2, (product.revenue / max) * 100)}%`,
                  backgroundColor: 'var(--seq-400)',
                }}
              />
            </div>
          </li>
        ))}
      </ul>
    </GlassCard>
  );
}
