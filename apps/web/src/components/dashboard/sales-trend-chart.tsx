'use client';

import {
  CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';

import { GlassCard } from '@/components/ui/glass-card';
import { formatCompact, formatCurrency } from '@/lib/utils';
import type { SalesTrendPoint } from '@/lib/demo-data';

/**
 * Retail vs wholesale over time.
 *
 * Both series are rupee values on a single shared axis. They are deliberately not split
 * onto two y-scales: a dual axis lets the reader "discover" crossings and gaps that are
 * an artefact of the scaling rather than the data.
 */
export function SalesTrendChart({ data }: { data: SalesTrendPoint[] }) {
  return (
    <GlassCard padding="md" className="h-full">
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Sales trend</h2>
          <p className="text-xs text-[var(--text-muted)]">Retail and wholesale, this month</p>
        </div>
      </div>

      <div className="h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
            {/* Grid and axes stay recessive — they orient, they do not compete */}
            <CartesianGrid stroke="var(--viz-grid)" strokeDasharray="0" vertical={false} />
            <XAxis
              dataKey="date"
              tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
              tickLine={false}
              axisLine={{ stroke: 'var(--viz-axis)' }}
              dy={6}
            />
            <YAxis
              tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(value: number) => formatCompact(value)}
              width={52}
            />
            <Tooltip
              cursor={{ stroke: 'var(--viz-axis)', strokeWidth: 1 }}
              contentStyle={{
                background: 'var(--glass-bg-strong)',
                backdropFilter: 'blur(20px)',
                border: '1px solid var(--glass-border)',
                borderRadius: '0.75rem',
                fontSize: 12,
                color: 'var(--text-primary)',
                boxShadow: 'var(--glass-shadow)',
              }}
              labelStyle={{ color: 'var(--text-secondary)', marginBottom: 4 }}
              formatter={(value: number, name: string) => [formatCurrency(value), name]}
            />
            <Legend
              verticalAlign="top"
              align="right"
              height={28}
              iconType="plainline"
              iconSize={14}
              wrapperStyle={{ fontSize: 12, color: 'var(--text-secondary)' }}
            />
            <Line
              type="monotone"
              dataKey="retail"
              name="Retail"
              stroke="var(--series-1)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--viz-surface)' }}
            />
            <Line
              type="monotone"
              dataKey="wholesale"
              name="Wholesale"
              stroke="var(--series-2)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--viz-surface)' }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </GlassCard>
  );
}
