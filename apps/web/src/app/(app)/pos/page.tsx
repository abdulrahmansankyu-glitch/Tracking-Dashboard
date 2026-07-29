'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Banknote, CreditCard, Loader2, Minus, Plus, Printer, Search, ShoppingCart,
  Smartphone, Trash2, X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { computeTax, toPaise, toRupees, type Paginated, type TaxLineInput } from '@intoto/shared';

import { Button } from '@/components/ui/button';
import { GlassCard } from '@/components/ui/glass-card';
import { Input } from '@/components/ui/input';
import { ApiError, api } from '@/lib/api';
import { cn, formatCurrency } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth-store';

/**
 * The billing counter.
 *
 * The running total is computed in the browser by the *same* GST engine the API uses to
 * write the invoice, imported from packages/shared. That is the whole reason the engine
 * lives there: the number the cashier reads out and the number filed in GSTR-1 come from
 * one piece of code and cannot drift apart.
 */

interface PosProduct {
  id: string;
  sku: string;
  name: string;
  hsnCode: string | null;
  gstRate: string;
  cessRate?: string;
  sellingPrice: string;
  wholesalePrice?: string | null;
  mrp: string;
  priceIncludesTax: boolean;
  colour?: string | null;
  size?: string | null;
  /** Quantity on hand at the selected shop */
  availableStock?: string;
}

interface StockRow {
  quantity: string;
  product: PosProduct;
}

interface CartLine {
  product: PosProduct;
  quantity: number;
  /** Rupees, editable at the counter */
  unitPrice: number;
  discountPercent: number;
}

interface Shop {
  id: string;
  name: string;
  code: string;
  stateCode: string;
}

const PAYMENT_MODES = [
  { mode: 'CASH' as const, label: 'Cash', icon: Banknote },
  { mode: 'UPI' as const, label: 'UPI', icon: Smartphone },
  { mode: 'CARD_DEBIT' as const, label: 'Card', icon: CreditCard },
];

export default function PosPage() {
  const queryClient = useQueryClient();
  const user = useAuthStore((state) => state.user);
  const activeShopId = useAuthStore((state) => state.activeShopId);

  const [shopId, setShopId] = useState<string>('');
  const [search, setSearch] = useState('');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [paymentMode, setPaymentMode] = useState<(typeof PAYMENT_MODES)[number]['mode']>('CASH');
  const [invoiceDiscount, setInvoiceDiscount] = useState(0);
  const [lastInvoice, setLastInvoice] = useState<Record<string, unknown> | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // --- Shops ---
  const shopsQuery = useQuery({
    queryKey: ['shops', 'pos'],
    queryFn: () => api.get<Paginated<Shop>>('/shops', { query: { pageSize: 100 } }),
  });
  const shops = shopsQuery.data?.data ?? [];

  useEffect(() => {
    if (shopId || shops.length === 0) return;
    setShopId(activeShopId ?? user?.shops[0]?.id ?? shops[0]!.id);
  }, [shops, shopId, activeShopId, user]);

  const shop = shops.find((s) => s.id === shopId);

  // --- Products, with stock at the SELECTED shop ---
  //
  // Deliberately not the product list: that carries the roll-up across every branch, so
  // the counter would read "8 left" when all eight sit in another shop and the sale
  // would then be refused at save time. This asks the one question that matters here —
  // what can I sell from this shop, right now.
  const productsQuery = useQuery({
    queryKey: ['pos-products', shopId, search],
    queryFn: () =>
      api.get<Paginated<StockRow>>('/inventory/stock', {
        query: { shopId, search: search || undefined, pageSize: 24 },
      }),
    enabled: Boolean(shopId) && (search.length === 0 || search.length >= 2),
  });

  const products: PosProduct[] = (productsQuery.data?.data ?? []).map((row) => ({
    ...row.product,
    availableStock: row.quantity,
  }));

  // --- Cart ---
  function addToCart(product: PosProduct) {
    setCart((current) => {
      const existing = current.find((line) => line.product.id === product.id);
      if (existing) {
        return current.map((line) =>
          line.product.id === product.id ? { ...line, quantity: line.quantity + 1 } : line,
        );
      }
      return [
        ...current,
        {
          product,
          quantity: 1,
          unitPrice: Number.parseFloat(product.sellingPrice),
          discountPercent: 0,
        },
      ];
    });
    setSearch('');
    searchRef.current?.focus();
  }

  function updateLine(productId: string, patch: Partial<CartLine>) {
    setCart((current) =>
      current.map((line) => (line.product.id === productId ? { ...line, ...patch } : line)),
    );
  }

  function removeLine(productId: string) {
    setCart((current) => current.filter((line) => line.product.id !== productId));
  }

  // --- Live totals, from the shared engine ---
  const tax = useMemo(() => {
    if (cart.length === 0 || !shop) return null;
    const lines: TaxLineInput[] = cart.map((line) => ({
      lineId: line.product.id,
      description: line.product.name,
      hsnCode: line.product.hsnCode,
      quantity: line.quantity,
      unitPrice: toPaise(line.unitPrice),
      discountPercent: line.discountPercent || undefined,
      gstRate: Number.parseFloat(line.product.gstRate),
      cessRate: line.product.cessRate ? Number.parseFloat(line.product.cessRate) : 0,
      taxInclusive: line.product.priceIncludesTax,
    }));
    return computeTax(lines, {
      // Over-the-counter sale: place of supply is the shop's own state.
      supplierStateCode: shop.stateCode,
      placeOfSupplyStateCode: shop.stateCode,
      invoiceDiscount: invoiceDiscount ? toPaise(invoiceDiscount) : 0,
    });
  }, [cart, shop, invoiceDiscount]);

  const grandTotal = tax ? toRupees(tax.totals.grandTotal) : 0;

  // --- Save ---
  const saveBill = useMutation({
    mutationFn: () =>
      api.post<Record<string, unknown>>('/sales', {
        shopId,
        walkInName: customerName || undefined,
        walkInPhone: customerPhone || undefined,
        invoiceDiscount: invoiceDiscount || undefined,
        lines: cart.map((line) => ({
          productId: line.product.id,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          discountPercent: line.discountPercent || undefined,
        })),
        payments: [{ mode: paymentMode, amount: grandTotal }],
      }),
    onSuccess: (invoice) => {
      toast.success(`Bill ${String(invoice.invoiceNumber)} saved`);
      setLastInvoice(invoice);
      setCart([]);
      setCustomerName('');
      setCustomerPhone('');
      setInvoiceDiscount(0);
      // Stock changed, so any list showing quantities is now stale.
      void queryClient.invalidateQueries({ queryKey: ['pos-products'] });
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      searchRef.current?.focus();
    },
    onError: (error) => {
      // The API refuses to oversell; that message names the product and the quantity,
      // which is exactly what the cashier needs to tell the customer.
      toast.error(
        error instanceof ApiError
          ? [error.message, ...Object.values(error.details ?? {}).flat()].join(' — ')
          : (error as Error).message,
      );
    },
  });

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_400px]">
      {/* ---------------- Products ---------------- */}
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight">Billing</h1>
          <select
            value={shopId}
            onChange={(event) => setShopId(event.target.value)}
            aria-label="Shop"
            className="h-10 rounded-xl border border-[var(--glass-ring)] bg-[var(--glass-bg)] px-3 text-sm"
          >
            {shops.map((option) => (
              <option key={option.id} value={option.id}>{option.name}</option>
            ))}
          </select>
        </div>

        <Input
          ref={searchRef}
          type="search"
          autoFocus
          placeholder="Scan barcode, or type product name / SKU…"
          icon={<Search className="h-4 w-4" />}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            // A barcode scanner types the code then presses Enter. One exact match goes
            // straight into the bill so the counter never touches the mouse.
            if (event.key === 'Enter' && products.length === 1) {
              addToCart(products[0]!);
            }
          }}
          aria-label="Search products"
        />

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
          {productsQuery.isLoading && (
            <div className="col-span-full grid place-items-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-[var(--text-muted)]" />
            </div>
          )}

          {!productsQuery.isLoading && products.length === 0 && (
            <p className="col-span-full py-12 text-center text-sm text-[var(--text-muted)]">
              {search ? `Nothing matches “${search}”.` : 'No products yet.'}
            </p>
          )}

          {products.map((product) => {
            const stock = Number.parseFloat(product.availableStock ?? '0');
            const outOfStock = stock <= 0;
            return (
              <GlassCard
                key={product.id}
                padding="sm"
                interactive={!outOfStock}
                onClick={() => !outOfStock && addToCart(product)}
                className={cn('flex flex-col justify-between', outOfStock && 'opacity-50')}
              >
                <div>
                  <p className="line-clamp-2 text-sm font-medium leading-snug">{product.name}</p>
                  <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">{product.sku}</p>
                </div>
                <div className="mt-2 flex items-end justify-between gap-2">
                  <span className="text-sm font-semibold">
                    {formatCurrency(product.sellingPrice)}
                  </span>
                  <span
                    className={cn(
                      'text-[10px] font-medium',
                      outOfStock ? 'text-[var(--status-critical)]' : 'text-[var(--text-muted)]',
                    )}
                  >
                    {outOfStock ? 'Out of stock' : `${stock} left`}
                  </span>
                </div>
              </GlassCard>
            );
          })}
        </div>
      </div>

      {/* ---------------- Bill ---------------- */}
      <GlassCard variant="strong" padding="none" className="flex h-fit flex-col lg:sticky lg:top-20">
        <div className="flex items-center gap-2 border-b border-[var(--glass-ring)] px-4 py-3">
          <ShoppingCart className="h-4 w-4 text-[var(--color-brand-500)]" aria-hidden />
          <h2 className="font-semibold">Current bill</h2>
          {cart.length > 0 && (
            <button
              onClick={() => setCart([])}
              className="ml-auto text-xs text-[var(--text-muted)] hover:text-[var(--status-critical)]"
            >
              Clear
            </button>
          )}
        </div>

        <div className="max-h-[38vh] overflow-y-auto px-4 py-3">
          {cart.length === 0 ? (
            <p className="py-8 text-center text-sm text-[var(--text-muted)]">
              Scan or tap a product to start a bill.
            </p>
          ) : (
            <ul className="space-y-3">
              {cart.map((line) => (
                <li key={line.product.id} className="border-b border-[var(--glass-ring)] pb-3 last:border-0">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{line.product.name}</p>
                      <p className="text-[11px] text-[var(--text-muted)]">
                        {line.product.sku} · GST {line.product.gstRate}%
                      </p>
                    </div>
                    <button
                      onClick={() => removeLine(line.product.id)}
                      className="rounded p-1 text-[var(--text-muted)] hover:text-[var(--status-critical)]"
                      aria-label={`Remove ${line.product.name}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  <div className="mt-2 flex items-center gap-2">
                    <div className="flex items-center rounded-lg border border-[var(--glass-ring)]">
                      <button
                        onClick={() =>
                          updateLine(line.product.id, { quantity: Math.max(1, line.quantity - 1) })
                        }
                        className="px-2 py-1 hover:bg-[var(--glass-bg)]"
                        aria-label="Decrease quantity"
                      >
                        <Minus className="h-3 w-3" />
                      </button>
                      <input
                        type="number"
                        min={0.01}
                        step="any"
                        value={line.quantity}
                        onChange={(event) =>
                          updateLine(line.product.id, {
                            quantity: Math.max(0.01, Number(event.target.value) || 1),
                          })
                        }
                        aria-label="Quantity"
                        className="tabular w-12 bg-transparent text-center text-sm outline-none"
                      />
                      <button
                        onClick={() => updateLine(line.product.id, { quantity: line.quantity + 1 })}
                        className="px-2 py-1 hover:bg-[var(--glass-bg)]"
                        aria-label="Increase quantity"
                      >
                        <Plus className="h-3 w-3" />
                      </button>
                    </div>

                    <span className="text-xs text-[var(--text-muted)]">×</span>
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={line.unitPrice}
                      onChange={(event) =>
                        updateLine(line.product.id, { unitPrice: Number(event.target.value) || 0 })
                      }
                      aria-label="Unit price"
                      className="tabular w-20 rounded-lg border border-[var(--glass-ring)] bg-[var(--glass-bg)] px-2 py-1 text-right text-sm outline-none"
                    />

                    <span className="tabular ml-auto text-sm font-semibold">
                      {formatCurrency(line.quantity * line.unitPrice)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Totals */}
        {tax && (
          <div className="space-y-1.5 border-t border-[var(--glass-ring)] px-4 py-3 text-sm">
            <Row label="Taxable value" value={toRupees(tax.totals.taxableValue)} />
            {tax.totals.cgst > 0 && (
              <>
                <Row label="CGST" value={toRupees(tax.totals.cgst)} muted />
                <Row label="SGST" value={toRupees(tax.totals.sgst)} muted />
              </>
            )}
            {tax.totals.igst > 0 && <Row label="IGST" value={toRupees(tax.totals.igst)} muted />}
            {tax.totals.roundOff !== 0 && (
              <Row label="Round off" value={toRupees(tax.totals.roundOff)} muted />
            )}
            <div className="flex items-baseline justify-between border-t border-[var(--glass-ring)] pt-2">
              <span className="font-semibold">Total</span>
              <span className="text-xl font-bold">{formatCurrency(grandTotal)}</span>
            </div>
          </div>
        )}

        {/* Customer + payment */}
        <div className="space-y-3 border-t border-[var(--glass-ring)] px-4 py-3">
          <div className="grid grid-cols-2 gap-2">
            <input
              placeholder="Customer name"
              value={customerName}
              onChange={(event) => setCustomerName(event.target.value)}
              aria-label="Customer name"
              className="h-9 rounded-lg border border-[var(--glass-ring)] bg-[var(--glass-bg)] px-2.5 text-sm"
            />
            <input
              placeholder="Phone"
              inputMode="numeric"
              value={customerPhone}
              onChange={(event) => setCustomerPhone(event.target.value)}
              aria-label="Customer phone"
              className="h-9 rounded-lg border border-[var(--glass-ring)] bg-[var(--glass-bg)] px-2.5 text-sm"
            />
          </div>

          <div className="grid grid-cols-3 gap-2">
            {PAYMENT_MODES.map(({ mode, label, icon: Icon }) => (
              <button
                key={mode}
                onClick={() => setPaymentMode(mode)}
                aria-pressed={paymentMode === mode}
                className={cn(
                  'flex flex-col items-center gap-1 rounded-lg border py-2 text-xs transition-colors',
                  paymentMode === mode
                    ? 'border-[var(--color-brand-500)] bg-[var(--color-brand-500)]/12 font-medium text-[var(--color-brand-600)]'
                    : 'border-[var(--glass-ring)] text-[var(--text-secondary)] hover:bg-[var(--glass-bg)]',
                )}
              >
                <Icon className="h-4 w-4" aria-hidden />
                {label}
              </button>
            ))}
          </div>

          <Button
            className="w-full"
            size="lg"
            disabled={cart.length === 0 || !shopId}
            loading={saveBill.isPending}
            onClick={() => saveBill.mutate()}
          >
            {cart.length === 0 ? 'Add items to bill' : `Save bill · ${formatCurrency(grandTotal)}`}
          </Button>
        </div>
      </GlassCard>

      <InvoiceDialog invoice={lastInvoice} onClose={() => setLastInvoice(null)} />
    </div>
  );
}

function Row({ label, value, muted }: { label: string; value: number; muted?: boolean }) {
  return (
    <div className={cn('flex justify-between', muted && 'text-[var(--text-muted)]')}>
      <span>{label}</span>
      <span className="tabular">{formatCurrency(value)}</span>
    </div>
  );
}

/** Printable receipt shown straight after saving, so the customer can be handed a bill. */
function InvoiceDialog({
  invoice, onClose,
}: { invoice: Record<string, unknown> | null; onClose: () => void }) {
  if (!invoice) return null;
  const lines = (invoice.lines as Array<Record<string, unknown>>) ?? [];
  const shop = invoice.shop as Record<string, unknown> | undefined;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4 backdrop-blur-sm"
        onClick={onClose}
      >
        <motion.div
          initial={{ scale: 0.96, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
          onClick={(event) => event.stopPropagation()}
          className="glass-strong max-h-[85vh] w-full max-w-md overflow-y-auto rounded-2xl p-5"
          role="dialog"
          aria-label="Tax invoice"
        >
          <div className="flex items-start justify-between">
            <div>
              <h2 className="font-bold">Tax Invoice</h2>
              <p className="text-xs text-[var(--text-muted)]">{String(invoice.invoiceNumber)}</p>
            </div>
            <button onClick={onClose} className="rounded p-1 text-[var(--text-muted)]" aria-label="Close">
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="mt-3 border-y border-[var(--glass-ring)] py-2 text-xs text-[var(--text-secondary)]">
            <p className="font-medium text-[var(--text-primary)]">{String(shop?.name ?? '')}</p>
            {Boolean(shop?.gstin) && <p>GSTIN: {String(shop!.gstin)}</p>}
            {Boolean(invoice.walkInName) && <p>Customer: {String(invoice.walkInName)}</p>}
          </div>

          <table className="mt-3 w-full text-xs">
            <thead>
              <tr className="border-b border-[var(--glass-ring)] text-left text-[var(--text-muted)]">
                <th scope="col" className="pb-1">Item</th>
                <th scope="col" className="pb-1 text-right">Qty</th>
                <th scope="col" className="pb-1 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line, index) => (
                <tr key={index} className="border-b border-[var(--glass-ring)] last:border-0">
                  <td className="py-1.5">
                    {String(line.description)}
                    <span className="block text-[10px] text-[var(--text-muted)]">
                      HSN {String(line.hsnCode ?? '—')} · GST {String(line.gstRate)}%
                    </span>
                  </td>
                  <td className="tabular py-1.5 text-right">{String(line.quantity)}</td>
                  <td className="tabular py-1.5 text-right">{formatCurrency(String(line.lineTotal))}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="mt-3 space-y-1 border-t border-[var(--glass-ring)] pt-2 text-xs">
            <Row label="Taxable" value={Number(invoice.taxableValue)} />
            {Number(invoice.cgstAmount) > 0 && (
              <>
                <Row label="CGST" value={Number(invoice.cgstAmount)} muted />
                <Row label="SGST" value={Number(invoice.sgstAmount)} muted />
              </>
            )}
            {Number(invoice.igstAmount) > 0 && (
              <Row label="IGST" value={Number(invoice.igstAmount)} muted />
            )}
            <div className="flex justify-between border-t border-[var(--glass-ring)] pt-1.5 text-sm font-bold">
              <span>Total</span>
              <span className="tabular">{formatCurrency(String(invoice.grandTotal))}</span>
            </div>
          </div>

          <Button className="mt-4 w-full no-print" onClick={() => window.print()}>
            <Printer className="h-4 w-4" aria-hidden />
            Print
          </Button>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
