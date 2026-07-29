'use client';

import type { ResourceField } from '@/components/data/resource-form';
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


// The fields a shopkeeper actually fills in when adding stock. Everything else on the
// product model keeps its default and can be edited later.
const formFields: ResourceField[] = [
  { name: 'name', label: 'Product name', required: true, section: 'Product', wide: true },
  { name: 'sku', label: 'SKU / item code', required: true, section: 'Product' },
  { name: 'barcode', label: 'Barcode', section: 'Product', hint: 'Scan or type — used at the counter' },
  { name: 'categoryId', label: 'Category', type: 'select', required: true, section: 'Product',
    optionsFrom: { path: 'categories', labelKey: 'name' } },
  { name: 'supplierId', label: 'Supplier', type: 'select', section: 'Product',
    optionsFrom: { path: 'suppliers', labelKey: 'companyName' } },

  { name: 'colour', label: 'Colour', section: 'Details' },
  { name: 'size', label: 'Size', section: 'Details' },
  { name: 'fabric', label: 'Fabric', section: 'Details' },
  { name: 'design', label: 'Design / pattern', section: 'Details' },

  { name: 'purchaseCost', label: 'Purchase cost (₹)', type: 'currency', section: 'Pricing' },
  { name: 'sellingPrice', label: 'Selling price (₹)', type: 'currency', section: 'Pricing' },
  { name: 'mrp', label: 'MRP (₹)', type: 'currency', section: 'Pricing',
    hint: 'Selling price cannot exceed this' },
  { name: 'wholesalePrice', label: 'Wholesale price (₹)', type: 'currency', section: 'Pricing' },

  { name: 'hsnCode', label: 'HSN code', section: 'Tax', hint: '4, 6 or 8 digits — needed on GST invoices' },
  { name: 'gstRate', label: 'GST %', type: 'number', section: 'Tax', defaultValue: 5,
    hint: 'Apparel: 5% up to ₹1,000, 12% above' },
  { name: 'unitCode', label: 'Sold by', type: 'select', section: 'Tax', defaultValue: 'PCS',
    options: [
      { value: 'PCS', label: 'Pieces' }, { value: 'MTR', label: 'Metres' },
      { value: 'SET', label: 'Sets' }, { value: 'KGS', label: 'Kilograms' },
      { value: 'ROL', label: 'Rolls' }, { value: 'DOZ', label: 'Dozen' },
    ] },

  { name: 'minStock', label: 'Minimum stock', type: 'number', section: 'Stock',
    hint: 'Alerts you when stock drops to this level' },
  { name: 'shelfLocation', label: 'Shelf location', section: 'Stock' },
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
      formFields={formFields}
    />
  );
}
