import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merge Tailwind classes, with later classes winning conflicts. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Money arrives from the API as a decimal *string* — parsing it to a float would
 * reintroduce exactly the precision loss the backend works to avoid. These helpers
 * accept the string form and only convert at the point of display.
 */
export function formatCurrency(value: string | number | null | undefined): string {
  const amount = typeof value === 'string' ? Number.parseFloat(value) : (value ?? 0);
  if (!Number.isFinite(amount)) return '₹0.00';
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

/** Compact Indian units — the ones an owner actually reads on a dashboard tile. */
export function formatCompact(value: string | number | null | undefined): string {
  const amount = typeof value === 'string' ? Number.parseFloat(value) : (value ?? 0);
  if (!Number.isFinite(amount)) return '₹0';
  const abs = Math.abs(amount);
  const sign = amount < 0 ? '-' : '';
  if (abs >= 1_00_00_000) return `${sign}₹${(abs / 1_00_00_000).toFixed(2)}Cr`;
  if (abs >= 1_00_000) return `${sign}₹${(abs / 1_00_000).toFixed(2)}L`;
  if (abs >= 1_000) return `${sign}₹${(abs / 1_000).toFixed(1)}K`;
  return `${sign}₹${abs.toFixed(0)}`;
}

export function formatNumber(value: string | number | null | undefined, decimals = 0): string {
  const amount = typeof value === 'string' ? Number.parseFloat(value) : (value ?? 0);
  if (!Number.isFinite(amount)) return '0';
  return new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(amount);
}

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  });
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Kolkata',
  });
}

export function formatPercent(value: number | null | undefined, decimals = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value >= 0 ? '' : ''}${value.toFixed(decimals)}%`;
}

/** Ordered categorical series colours. Index by slot, never cycle past slot 8. */
export const SERIES_COLORS = [
  'var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)',
  'var(--series-5)', 'var(--series-6)', 'var(--series-7)', 'var(--series-8)',
] as const;

export function seriesColor(index: number): string {
  return SERIES_COLORS[index] ?? 'var(--text-muted)';
}
