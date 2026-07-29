'use client';

import type { ResourceField } from '@/components/data/resource-form';
import { ResourcePage, type ResourceColumn } from '@/components/data/resource-page';
import { INDIAN_STATES } from '@intoto/shared';

import { formatCompact, formatNumber } from '@/lib/utils';

const columns: ResourceColumn[] = [
  { key: 'code', header: 'Code' },
  { key: 'name', header: 'Shop' },
  { key: 'type', header: 'Type' },
  { key: 'city', header: 'City', hideOnMobile: true },
  { key: 'phone', header: 'Phone', sortable: false, hideOnMobile: true },
  {
    key: 'monthlyRent',
    header: 'Monthly Rent',
    align: 'right',
    render: (row) => (row.monthlyRent ? formatCompact(row.monthlyRent as string) : '—'),
  },
  {
    key: 'areaSqft',
    header: 'Area',
    align: 'right',
    hideOnMobile: true,
    render: (row) => (row.areaSqft ? `${formatNumber(row.areaSqft as number)} sqft` : '—'),
  },
];

// Adding shop #4 is filling in this form — no code change, no migration.
const formFields: ResourceField[] = [
  { name: 'name', label: 'Shop name', required: true, section: 'Shop', wide: true },
  {
    name: 'code', label: 'Short code', required: true, section: 'Shop',
    hint: 'Appears on invoice numbers, e.g. SHOP4',
  },
  {
    name: 'type', label: 'Type', type: 'select', required: true, section: 'Shop',
    defaultValue: 'BOTH',
    options: [
      { value: 'RETAIL', label: 'Retail' },
      { value: 'WHOLESALE', label: 'Wholesale' },
      { value: 'BOTH', label: 'Retail + Wholesale' },
      { value: 'WAREHOUSE', label: 'Warehouse' },
    ],
  },
  { name: 'gstin', label: 'GSTIN', section: 'Shop' },
  { name: 'phone', label: 'Phone', type: 'tel', section: 'Shop' },

  { name: 'addressLine1', label: 'Address', section: 'Address', wide: true },
  { name: 'city', label: 'City', section: 'Address' },
  { name: 'pincode', label: 'PIN code', section: 'Address' },
  {
    name: 'stateCode', label: 'State', type: 'select', section: 'Address', defaultValue: '09',
    hint: 'Decides CGST+SGST or IGST on every bill this shop issues',
    options: INDIAN_STATES.map((s) => ({ value: s.code, label: s.name })),
  },

  { name: 'monthlyRent', label: 'Monthly rent (₹)', type: 'currency', section: 'Costs' },
  { name: 'areaSqft', label: 'Area (sqft)', type: 'number', section: 'Costs' },
  { name: 'invoicePrefix', label: 'Invoice prefix', section: 'Costs', defaultValue: 'INV' },
];

export default function ShopsPage() {
  return (
    <ResourcePage
      path="shops"
      title="Shops"
      subtitle="Your branches — add as many as you need"
      label="Shop"
      resource="shop"
      columns={columns}
      defaultSortBy="name"
      searchPlaceholder="Search by name, code or city…"
      formFields={formFields}
    />
  );
}
