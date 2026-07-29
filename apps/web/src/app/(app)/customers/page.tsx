'use client';

import { ResourcePage, type ResourceColumn } from '@/components/data/resource-page';
import { formatCompact, formatDate, formatNumber } from '@/lib/utils';

const TYPE_ACCENT: Record<string, number> = {
  RETAIL: 1, WHOLESALE: 2, VIP: 4, REGULAR: 3, CORPORATE: 7,
};

const columns: ResourceColumn[] = [
  { key: 'code', header: 'Code' },
  {
    key: 'name',
    header: 'Customer',
    render: (row) => (
      <div className="min-w-0">
        <p className="truncate font-medium">{String(row.name ?? '')}</p>
        <p className="truncate text-xs text-[var(--text-muted)]">{String(row.phone ?? '')}</p>
      </div>
    ),
  },
  {
    key: 'type',
    header: 'Type',
    render: (row) => {
      const type = String(row.type ?? 'RETAIL');
      const slot = TYPE_ACCENT[type] ?? 1;
      return (
        <span
          className="rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
          style={{
            color: `var(--series-${slot})`,
            backgroundColor: `color-mix(in srgb, var(--series-${slot}) 14%, transparent)`,
          }}
        >
          {type}
        </span>
      );
    },
  },
  { key: 'city', header: 'City', hideOnMobile: true },
  {
    key: 'totalPurchases',
    header: 'Lifetime',
    align: 'right',
    render: (row) => formatCompact(row.totalPurchases as string),
  },
  {
    key: 'totalOrders',
    header: 'Orders',
    align: 'right',
    hideOnMobile: true,
    render: (row) => formatNumber(row.totalOrders as number),
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
    key: 'loyaltyPoints',
    header: 'Points',
    align: 'right',
    hideOnMobile: true,
    render: (row) => formatNumber(row.loyaltyPoints as number),
  },
  {
    key: 'lastPurchaseAt',
    header: 'Last Purchase',
    align: 'right',
    hideOnMobile: true,
    render: (row) => formatDate(row.lastPurchaseAt as string | null),
  },
];

export default function CustomersPage() {
  return (
    <ResourcePage
      path="customers"
      title="Customers"
      subtitle="Retail, wholesale and VIP accounts"
      label="Customer"
      resource="customer"
      columns={columns}
      defaultSortBy="name"
      searchPlaceholder="Search by name, phone, email or GSTIN…"
    />
  );
}
