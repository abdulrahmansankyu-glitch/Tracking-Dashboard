'use client';

import type { ResourceField } from '@/components/data/resource-form';
import { ResourcePage, type ResourceColumn } from '@/components/data/resource-page';
import { INDIAN_STATES } from '@intoto/shared';

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


// Lifetime value, order count and loyalty points are computed from sales — never typed.
const formFields: ResourceField[] = [
  { name: 'name', label: 'Customer name', required: true, section: 'Customer', wide: true },
  { name: 'phone', label: 'Phone', type: 'tel', required: true, section: 'Customer',
    hint: 'Used for WhatsApp bills and reminders' },
  { name: 'type', label: 'Customer type', type: 'select', required: true, section: 'Customer',
    defaultValue: 'RETAIL',
    options: [
      { value: 'RETAIL', label: 'Retail' }, { value: 'WHOLESALE', label: 'Wholesale' },
      { value: 'REGULAR', label: 'Regular' }, { value: 'VIP', label: 'VIP' },
      { value: 'CORPORATE', label: 'Corporate' },
    ] },
  { name: 'email', label: 'Email', type: 'email', section: 'Customer' },
  { name: 'gstin', label: 'GSTIN', section: 'Customer',
    hint: 'Required for wholesale customers claiming input credit' },

  { name: 'address.line1', label: 'Address', section: 'Address', wide: true },
  { name: 'address.city', label: 'City', section: 'Address' },
  { name: 'address.pincode', label: 'PIN code', section: 'Address' },
  { name: 'address.stateCode', label: 'State', type: 'select', section: 'Address',
    options: INDIAN_STATES.map((s) => ({ value: s.code, label: s.name })) },

  { name: 'birthday', label: 'Birthday', type: 'date', section: 'Relationship' },
  { name: 'anniversary', label: 'Anniversary', type: 'date', section: 'Relationship' },
  { name: 'creditLimit', label: 'Credit limit (₹)', type: 'currency', section: 'Relationship' },
  { name: 'creditPeriodDays', label: 'Credit period (days)', type: 'number', section: 'Relationship' },
  { name: 'notes', label: 'Notes', type: 'textarea', section: 'Relationship' },
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
      formFields={formFields}
    />
  );
}
