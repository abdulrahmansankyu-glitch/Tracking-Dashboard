'use client';

import { ResourcePage, type ResourceColumn } from '@/components/data/resource-page';
import { cn, formatCurrency, formatNumber } from '@/lib/utils';

const columns: ResourceColumn[] = [
  { key: 'sku', header: 'SKU' },
  {
    key: 'name',
    header: 'Product',
    render: (row) => {
      const category = row.category as { name?: string } | undefined;
      const attributes = [row.colour, row.size, row.fabric].filter(Boolean).join(' · ');
      return (
        <div className="min-w-0">
          <p className="truncate font-medium">{String(row.name ?? '')}</p>
          <p className="truncate text-xs text-[var(--text-muted)]">
            {[category?.name, attributes].filter(Boolean).join(' — ')}
          </p>
        </div>
      );
    },
  },
  {
    key: 'supplier.companyName',
    header: 'Supplier',
    sortable: false,
    hideOnMobile: true,
    render: (row) => {
      const supplier = row.supplier as { companyName?: string } | undefined;
      return supplier?.companyName ?? '—';
    },
  },
  { key: 'hsnCode', header: 'HSN', sortable: false, hideOnMobile: true },
  {
    key: 'gstRate',
    header: 'GST',
    align: 'right',
    hideOnMobile: true,
    render: (row) => `${formatNumber(row.gstRate as string, 0)}%`,
  },
  {
    key: 'purchaseCost',
    header: 'Cost',
    align: 'right',
    hideOnMobile: true,
    render: (row) => formatCurrency(row.purchaseCost as string),
  },
  {
    key: 'sellingPrice',
    header: 'Price',
    align: 'right',
    render: (row) => formatCurrency(row.sellingPrice as string),
  },
  {
    key: 'totalStock',
    header: 'Stock',
    align: 'right',
    render: (row) => {
      const stock = Number.parseFloat(String(row.totalStock ?? '0'));
      const minStock = Number.parseFloat(String(row.minStock ?? '0'));
      const low = minStock > 0 && stock <= minStock;
      return (
        <span className={cn(low && 'font-semibold text-[var(--status-critical)]')}>
          {formatNumber(stock, 2)}
          {/* Text, not just colour — the low-stock signal must survive greyscale */}
          {low && <span className="ml-1 text-[10px] uppercase">low</span>}
        </span>
      );
    },
  },
];

export default function ProductsPage() {
  return (
    <ResourcePage
      path="products"
      title="Products"
      subtitle="Catalogue, pricing and stock levels"
      label="Product"
      resource="product"
      columns={columns}
      defaultSortBy="name"
      searchPlaceholder="Search by name, SKU, barcode, colour or fabric…"
    />
  );
}
