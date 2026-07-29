'use client';

import { Star } from 'lucide-react';

import type { ResourceField } from '@/components/data/resource-form';
import { ResourcePage, type ResourceColumn } from '@/components/data/resource-page';
import { INDIAN_STATES } from '@intoto/shared';

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


// Only what is needed to add a supplier at the counter. Ratings, purchase totals and
// outstanding balances are computed by the system, never typed in.
const formFields: ResourceField[] = [
  { name: 'companyName', label: 'Company name', required: true, section: 'Business', wide: true },
  { name: 'ownerName', label: 'Owner / contact person', section: 'Business' },
  { name: 'category', label: 'Supplies', placeholder: 'Sarees, Fabric, Winter Wear…', section: 'Business' },
  { name: 'gstin', label: 'GSTIN', hint: '15 characters — checked against its check digit', section: 'Business' },
  { name: 'pan', label: 'PAN', section: 'Business' },

  { name: 'phone', label: 'Phone', type: 'tel', required: true, section: 'Contact' },
  { name: 'alternatePhone', label: 'Alternate phone', type: 'tel', section: 'Contact' },
  { name: 'email', label: 'Email', type: 'email', section: 'Contact' },

  { name: 'address.line1', label: 'Address', required: true, section: 'Address', wide: true },
  { name: 'address.city', label: 'City', required: true, section: 'Address' },
  { name: 'address.pincode', label: 'PIN code', required: true, section: 'Address' },
  { name: 'address.stateCode', label: 'State', type: 'select', required: true, section: 'Address',
    options: INDIAN_STATES.map((s) => ({ value: s.code, label: s.name })) },

  { name: 'creditPeriodDays', label: 'Credit period (days)', type: 'number', section: 'Terms',
    hint: 'Days before payment is due', defaultValue: 30 },
  { name: 'creditLimit', label: 'Credit limit (₹)', type: 'currency', section: 'Terms' },
  { name: 'notes', label: 'Notes', type: 'textarea', section: 'Terms' },
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
      formFields={formFields}
    />
  );
}
