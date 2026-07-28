/**
 * Cross-cutting types shared by the API and the web client.
 * Domain enums are declared here (not only in Prisma) so the frontend can use them
 * without importing the database client.
 */

// ---------------------------------------------------------------------------
// Document lifecycle
// ---------------------------------------------------------------------------

export const DOCUMENT_STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'PARTIALLY_FULFILLED',
  'FULFILLED',
  'COMPLETED',
  'CANCELLED',
  'VOID',
] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const PAYMENT_STATUSES = ['UNPAID', 'PARTIAL', 'PAID', 'OVERDUE', 'REFUNDED'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PAYMENT_MODES = [
  'CASH',
  'UPI',
  'CARD_DEBIT',
  'CARD_CREDIT',
  'NET_BANKING',
  'CHEQUE',
  'BANK_TRANSFER',
  'WALLET',
  'GIFT_CARD',
  'STORE_CREDIT',
  'CREDIT',
] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

export const CUSTOMER_TYPES = ['RETAIL', 'WHOLESALE', 'VIP', 'REGULAR', 'CORPORATE'] as const;
export type CustomerType = (typeof CUSTOMER_TYPES)[number];

export const VALUATION_METHODS = ['FIFO', 'LIFO', 'WEIGHTED_AVERAGE'] as const;
export type ValuationMethod = (typeof VALUATION_METHODS)[number];

export const STOCK_MOVEMENT_TYPES = [
  'OPENING',
  'PURCHASE',
  'PURCHASE_RETURN',
  'SALE',
  'SALES_RETURN',
  'TRANSFER_OUT',
  'TRANSFER_IN',
  'ADJUSTMENT_INCREASE',
  'ADJUSTMENT_DECREASE',
  'DAMAGED',
  'LOST',
  'CYCLE_COUNT',
  'PRODUCTION',
] as const;
export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number];

/** Movements that increase quantity on hand. Everything else decreases it. */
export const INBOUND_MOVEMENTS: readonly StockMovementType[] = [
  'OPENING',
  'PURCHASE',
  'SALES_RETURN',
  'TRANSFER_IN',
  'ADJUSTMENT_INCREASE',
  'PRODUCTION',
];

export function movementDirection(type: StockMovementType): 1 | -1 {
  return INBOUND_MOVEMENTS.includes(type) ? 1 : -1;
}

// ---------------------------------------------------------------------------
// Accounting
// ---------------------------------------------------------------------------

export const ACCOUNT_TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/** Assets and expenses carry debit balances; everything else carries credit. */
export function normalBalance(type: AccountType): 'DEBIT' | 'CREDIT' {
  return type === 'ASSET' || type === 'EXPENSE' ? 'DEBIT' : 'CREDIT';
}

export const JOURNAL_SOURCES = [
  'SALES_INVOICE',
  'SALES_RETURN',
  'PURCHASE_BILL',
  'PURCHASE_RETURN',
  'PAYMENT',
  'RECEIPT',
  'EXPENSE',
  'PAYROLL',
  'STOCK_ADJUSTMENT',
  'DEPRECIATION',
  'MANUAL',
  'OPENING_BALANCE',
  'CONTRA',
] as const;
export type JournalSource = (typeof JOURNAL_SOURCES)[number];

// ---------------------------------------------------------------------------
// API envelope
// ---------------------------------------------------------------------------

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrevious: boolean;
}

export interface Paginated<T> {
  data: T[];
  meta: PageMeta;
}

export interface ApiError {
  statusCode: number;
  message: string;
  error?: string;
  /** Field-level validation problems, keyed by dotted path */
  details?: Record<string, string[]>;
  correlationId?: string;
  timestamp: string;
  path: string;
}

export type SortDirection = 'asc' | 'desc';

export const FILTER_OPERATORS = [
  'eq', 'ne', 'gt', 'gte', 'lt', 'lte',
  'contains', 'startsWith', 'endsWith',
  'in', 'notIn', 'between', 'isNull', 'isNotNull',
] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

export interface FilterCondition {
  field: string;
  operator: FilterOperator;
  value?: unknown;
}

export interface QueryParams {
  page?: number;
  pageSize?: number;
  search?: string;
  sortBy?: string;
  sortDir?: SortDirection;
  filters?: FilterCondition[];
  /** Include soft-deleted / archived rows */
  includeArchived?: boolean;
  onlyArchived?: boolean;
  shopId?: string;
  dateFrom?: string;
  dateTo?: string;
}

export const EXPORT_FORMATS = ['xlsx', 'csv', 'pdf', 'json'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export const REPORT_PERIODS = [
  'TODAY', 'YESTERDAY', 'THIS_WEEK', 'LAST_WEEK',
  'THIS_MONTH', 'LAST_MONTH', 'THIS_QUARTER', 'LAST_QUARTER',
  'THIS_YEAR', 'LAST_YEAR', 'THIS_FINANCIAL_YEAR', 'LAST_FINANCIAL_YEAR',
  'CUSTOM',
] as const;
export type ReportPeriod = (typeof REPORT_PERIODS)[number];

export const REPORT_GROUPINGS = [
  'NONE', 'DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR',
  'SHOP', 'SUPPLIER', 'CATEGORY', 'CUSTOMER', 'PRODUCT', 'BRAND', 'EMPLOYEE', 'PAYMENT_MODE',
] as const;
export type ReportGrouping = (typeof REPORT_GROUPINGS)[number];

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export const AUDIT_ACTIONS = [
  'CREATE', 'UPDATE', 'DELETE', 'ARCHIVE', 'RESTORE',
  'LOGIN', 'LOGOUT', 'LOGIN_FAILED', 'PASSWORD_CHANGE', 'TWO_FACTOR_ENABLED', 'TWO_FACTOR_DISABLED',
  'EXPORT', 'IMPORT', 'PRINT', 'APPROVE', 'REJECT', 'VOID', 'PAYMENT', 'PERMISSION_CHANGE',
  'VIEW_SENSITIVE',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditFieldChange {
  field: string;
  from: unknown;
  to: unknown;
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export interface KpiValue {
  key: string;
  label: string;
  /** Paise for money metrics, plain number otherwise */
  value: number;
  format: 'currency' | 'number' | 'percent' | 'duration';
  /** Percentage change vs the comparison period */
  changePercent?: number;
  trend?: 'up' | 'down' | 'flat';
  /** Whether an upward move is good — profit yes, returns no */
  higherIsBetter?: boolean;
  sparkline?: number[];
  subtitle?: string;
}

export const ALERT_SEVERITIES = ['INFO', 'WARNING', 'CRITICAL'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export interface BusinessAlert {
  id: string;
  severity: AlertSeverity;
  category: 'STOCK' | 'PAYMENT' | 'COMPLIANCE' | 'HR' | 'SALES' | 'SYSTEM';
  title: string;
  message: string;
  actionLabel?: string;
  actionHref?: string;
  entityId?: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Product classification (matches the Intoto catalogue)
// ---------------------------------------------------------------------------

export const PRODUCT_CATEGORY_TREE = [
  {
    name: 'Fabric',
    children: ['Cotton Rolls', 'Silk Rolls', 'Synthetic Rolls', 'Wool Fabric', 'Linen Fabric'],
  },
  {
    name: 'Sarees',
    children: ['Banarasi Saree', 'Cotton Saree', 'Silk Saree', 'Wedding Saree', 'Designer Saree'],
  },
  {
    name: 'Men Wear',
    children: ['Sherwani', 'Groom Sets', 'Kurta', 'Pajama', 'Shirt', 'Pant', 'Suit', 'Ethnic Jacket'],
  },
  {
    name: 'Ladies Wear',
    children: ['Salwar Suit', 'Lehenga', 'Kurti', 'Dress Material', 'Blouse', 'Dupatta'],
  },
  {
    name: 'Children Wear',
    children: ['Boys Wear', 'Girls Wear', 'Infant Wear', 'Party Wear'],
  },
  {
    name: 'Winter Wear',
    children: ['Blankets', 'Kashmiri Shawls', 'Ladies Stoles', 'Winter Stoles', 'Sweaters', 'Jackets'],
  },
  {
    name: 'Uniforms',
    children: ['School Uniform', 'College Uniform', 'Corporate Uniform', 'Sports Uniform'],
  },
  {
    name: 'Accessories',
    children: ['Belts', 'Ties', 'Handkerchiefs', 'Socks', 'Imitation Jewellery', 'Bags'],
  },
] as const;

export const SEASONS = ['ALL_SEASON', 'SUMMER', 'MONSOON', 'WINTER', 'FESTIVE', 'WEDDING'] as const;
export type Season = (typeof SEASONS)[number];

// ---------------------------------------------------------------------------
// Utility helpers used by both tiers
// ---------------------------------------------------------------------------

/** Indian financial year label for a date, e.g. "2025-26". */
export function financialYearLabel(date: Date, startMonth = 4): string {
  const month = date.getMonth() + 1;
  const year = date.getFullYear();
  const startYear = month >= startMonth ? year : year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/** Inclusive start/end of the financial year containing `date`. */
export function financialYearRange(date: Date, startMonth = 4): { start: Date; end: Date } {
  const month = date.getMonth() + 1;
  const year = date.getFullYear();
  const startYear = month >= startMonth ? year : year - 1;
  return {
    start: new Date(startYear, startMonth - 1, 1, 0, 0, 0, 0),
    end: new Date(startYear + 1, startMonth - 1, 0, 23, 59, 59, 999),
  };
}
