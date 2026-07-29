'use client';

import { Star } from 'lucide-react';

import { ResourcePage, type ResourceColumn } from '@/components/data/resource-page';
import { formatCompact, formatNumber } from '@/lib/utils';

const columns: ResourceColumn[] = [
  { key: 'code', header: 'Code' },
  {
    key: 'companyName',
    header: 'Company',
    render: (row) => (
      <div className="min-w-0">
        <p className="truncate font-medium">{String(row.companyName ?? '')}</p>
        {Boolean(row.ownerName) && (
          <p className="truncate text-xs text-[var(--text-muted)]">{String(row.ownerName)}</p>
        )}
      </div>
    ),
  },
  { key: 'phone', header: 'Phone', sortable: false },
  { key: 'city', header: 'City', hideOnMobile: true },
  { key: 'category', header: 'Category', sortable: false, hideOnMobile: true },
  {
    key: 'creditPeriodDays',
    header: 'Credit',
    align: 'right',
    hideOnMobile: true,
    render: (row) => `${formatNumber(row.creditPeriodDays as number)} days`,
  },
  {
    key: 'totalPurchaseValue',
    header: 'Purchased',
    align: 'right',
    render: (row) => formatCompact(row.totalPurchaseValue as string),
  },
  {
    key: 'outstandingAmount',
    header: 'Outstanding',
    align: 'right',
    render: (row) => {
      const value = Number.parseFloat(String(row.outstandingAmount ?? '0'));
      return (
        <span className={value > 0 ? 'text-[var(--status-warning)]' : undefined}>
          {formatCompact(value)}
        </span>
      );
    },
  },
  {
    key: 'overallRating',
    header: 'Rating',
    align: 'right',
    render: (row) => {
      const rating = Number.parseFloat(String(row.overallRating ?? '0'));
      if (!rating) return <span className="text-[var(--text-muted)]">—</span>;
      return (
        // Icon plus the number: a star alone would carry the meaning in colour only.
        <span className="inline-flex items-center gap-1">
          <Star className="h-3.5 w-3.5 fill-[var(--status-warning)] text-[var(--status-warning)]" aria-hidden />
          {rating.toFixed(1)}
        </span>
      );
    },
  },
];

export default function SuppliersPage() {
  return (
    <ResourcePage
      path="suppliers"
      title="Suppliers"
      subtitle="Purchase sources, credit terms and performance"
      label="Supplier"
      resource="supplier"
      columns={columns}
      defaultSortBy="companyName"
      searchPlaceholder="Search by company, owner, phone, GSTIN or city…"
    />
  );
}
