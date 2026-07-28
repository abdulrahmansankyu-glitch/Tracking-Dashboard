'use client';

import { motion } from 'framer-motion';
import { ArrowDownRight, ArrowRight, ArrowUpRight } from 'lucide-react';

import { GlassCard } from '@/components/ui/glass-card';
import { cn, formatCompact, formatNumber, formatPercent } from '@/lib/utils';

export interface KpiTileProps {
  label: string;
  value: number;
  format?: 'currency' | 'number' | 'percent';
  changePercent?: number;
  /** Whether a rise is good. Returns and expenses rise badly; profit rises well. */
  higherIsBetter?: boolean;
  subtitle?: string;
  icon?: React.ComponentType<{ className?: string }>;
  /** Slot 1–8 of the categorical palette, used only for the icon accent */
  accent?: number;
  sparkline?: number[];
  index?: number;
}

/**
 * A stat tile: one headline number, its movement, and optionally a bare sparkline.
 *
 * Deliberately not a chart — the job is "what is the number", and a chart would make
 * that slower to read. The sparkline carries shape only; it has no axes and no labels
 * because it is not meant to be measured.
 */
export function KpiTile({
  label,
  value,
  format = 'currency',
  changePercent,
  higherIsBetter = true,
  subtitle,
  icon: Icon,
  accent = 1,
  sparkline,
  index = 0,
}: KpiTileProps) {
  const display =
    format === 'currency'
      ? formatCompact(value)
      : format === 'percent'
        ? `${formatNumber(value, 1)}%`
        : formatNumber(value);

  const hasChange = changePercent !== undefined && Number.isFinite(changePercent);
  const isFlat = hasChange && Math.abs(changePercent) < 0.05;
  const isGood = hasChange && !isFlat && (changePercent > 0) === higherIsBetter;

  const DeltaIcon = isFlat ? ArrowRight : changePercent! > 0 ? ArrowUpRight : ArrowDownRight;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay: index * 0.04, ease: [0.16, 1, 0.3, 1] }}
    >
      <GlassCard interactive className="h-full">
        <div className="flex items-start justify-between gap-3">
          <p className="text-[13px] font-medium text-[var(--text-secondary)]">{label}</p>
          {Icon && (
            <span
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg"
              style={{ backgroundColor: `color-mix(in srgb, var(--series-${accent}) 14%, transparent)` }}
              aria-hidden
            >
              <Icon className="h-4 w-4" />
            </span>
          )}
        </div>

        {/* Hero figure keeps proportional figures — it is standalone, not a column */}
        <p className="mt-2 text-2xl font-bold tracking-tight">{display}</p>

        <div className="mt-1.5 flex items-center gap-2">
          {hasChange && (
            <span
              className={cn(
                'inline-flex items-center gap-0.5 text-xs font-medium',
                isFlat
                  ? 'text-[var(--text-muted)]'
                  : isGood
                    ? 'text-[var(--delta-up)]'
                    : 'text-[var(--delta-down)]',
              )}
            >
              {/* Icon + sign, so direction never rests on colour alone */}
              <DeltaIcon className="h-3.5 w-3.5" aria-hidden />
              {formatPercent(Math.abs(changePercent!))}
            </span>
          )}
          {subtitle && <span className="text-xs text-[var(--text-muted)]">{subtitle}</span>}
        </div>

        {sparkline && sparkline.length > 1 && (
          <Sparkline points={sparkline} accent={accent} />
        )}
      </GlassCard>
    </motion.div>
  );
}

function Sparkline({ points, accent }: { points: number[]; accent: number }) {
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const width = 100;
  const height = 28;

  const path = points
    .map((point, i) => {
      const x = (i / (points.length - 1)) * width;
      const y = height - ((point - min) / range) * height;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="mt-3 h-7 w-full"
      role="presentation"
      aria-hidden
    >
      <path
        d={path}
        fill="none"
        stroke={`var(--series-${accent})`}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
