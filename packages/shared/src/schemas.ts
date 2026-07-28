/**
 * Zod validation schemas.
 *
 * These are the contract between client and server: the API validates request bodies
 * with them and the web forms infer their field types from the same objects, so a schema
 * change surfaces as a TypeScript error in the form rather than a 400 at runtime.
 */

import { z } from 'zod';

import { INDIAN_STATES } from './constants/india';
import { isValidGstin, isValidIfsc, isValidIndianMobile, isValidPan, isValidUpiId } from './gst';
import {
  ACCOUNT_TYPES, CUSTOMER_TYPES, EXPORT_FORMATS, FILTER_OPERATORS,
  PAYMENT_MODES, REPORT_GROUPINGS, REPORT_PERIODS, SEASONS, VALUATION_METHODS,
} from './types';

const STATE_CODES = INDIAN_STATES.map((s) => s.code) as [string, ...string[]];

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const gstinSchema = z
  .string()
  .trim()
  .toUpperCase()
  .length(15, 'GSTIN must be exactly 15 characters')
  .refine(isValidGstin, 'Invalid GSTIN — the check digit does not match');

export const panSchema = z
  .string()
  .trim()
  .toUpperCase()
  .length(10, 'PAN must be exactly 10 characters')
  .refine(isValidPan, 'Invalid PAN format (expected AAAAA9999A)');

export const ifscSchema = z
  .string()
  .trim()
  .toUpperCase()
  .length(11)
  .refine(isValidIfsc, 'Invalid IFSC code');

export const upiSchema = z.string().trim().refine(isValidUpiId, 'Invalid UPI ID (expected name@bank)');

export const indianMobileSchema = z
  .string()
  .trim()
  .refine(isValidIndianMobile, 'Enter a valid 10-digit Indian mobile number');

export const stateCodeSchema = z.enum(STATE_CODES, {
  errorMap: () => ({ message: 'Select a valid Indian state' }),
});

export const pincodeSchema = z
  .string()
  .trim()
  .regex(/^[1-9][0-9]{5}$/, 'PIN code must be 6 digits and cannot start with 0');

/** Money accepted as rupees from the client; converted to paise server-side. */
export const rupeesSchema = z.coerce.number().finite().min(0, 'Amount cannot be negative');
export const signedRupeesSchema = z.coerce.number().finite();
export const quantitySchema = z.coerce.number().finite().min(0);
export const percentSchema = z.coerce.number().min(0).max(100);

export const cuidSchema = z.string().min(1, 'Required');

// ---------------------------------------------------------------------------
// Shared sub-objects
// ---------------------------------------------------------------------------

export const addressSchema = z.object({
  line1: z.string().trim().min(1, 'Address line 1 is required').max(200),
  line2: z.string().trim().max(200).optional().or(z.literal('')),
  city: z.string().trim().min(1, 'City is required').max(100),
  district: z.string().trim().max(100).optional().or(z.literal('')),
  stateCode: stateCodeSchema,
  pincode: pincodeSchema,
  country: z.string().default('IN'),
  landmark: z.string().trim().max(200).optional().or(z.literal('')),
});
export type AddressInput = z.infer<typeof addressSchema>;

export const bankDetailsSchema = z.object({
  accountHolderName: z.string().trim().min(1).max(150),
  accountNumber: z.string().trim().min(6).max(20).regex(/^\d+$/, 'Account number must be digits'),
  ifsc: ifscSchema,
  bankName: z.string().trim().min(1).max(150),
  branch: z.string().trim().max(150).optional().or(z.literal('')),
  accountType: z.enum(['SAVINGS', 'CURRENT', 'CC', 'OD']).default('CURRENT'),
});
export type BankDetailsInput = z.infer<typeof bankDetailsSchema>;

// ---------------------------------------------------------------------------
// Query / list
// ---------------------------------------------------------------------------

export const filterConditionSchema = z.object({
  field: z.string().min(1),
  operator: z.enum(FILTER_OPERATORS),
  value: z.unknown().optional(),
});

export const queryParamsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(25),
  search: z.string().trim().max(200).optional(),
  sortBy: z.string().max(100).optional(),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
  filters: z.array(filterConditionSchema).optional(),
  includeArchived: z.coerce.boolean().default(false),
  onlyArchived: z.coerce.boolean().default(false),
  shopId: cuidSchema.optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
});
export type QueryParamsInput = z.infer<typeof queryParamsSchema>;

export const exportRequestSchema = queryParamsSchema.extend({
  format: z.enum(EXPORT_FORMATS).default('xlsx'),
  columns: z.array(z.string()).optional(),
  title: z.string().max(200).optional(),
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const loginSchema = z.object({
  identifier: z.string().trim().min(1, 'Enter your email or mobile number'),
  password: z.string().min(1, 'Password is required'),
  twoFactorCode: z.string().regex(/^\d{6}$/).optional(),
  rememberMe: z.boolean().default(false),
});

export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .regex(/[a-z]/, 'Include a lowercase letter')
  .regex(/[A-Z]/, 'Include an uppercase letter')
  .regex(/\d/, 'Include a number')
  .regex(/[^A-Za-z0-9]/, 'Include a symbol');

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1),
    newPassword: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((v) => v.newPassword === v.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

// ---------------------------------------------------------------------------
// Shop
// ---------------------------------------------------------------------------

export const shopSchema = z.object({
  code: z.string().trim().min(2).max(20).regex(/^[A-Z0-9_-]+$/i, 'Use letters, numbers, - or _'),
  name: z.string().trim().min(2).max(150),
  legalName: z.string().trim().max(200).optional().or(z.literal('')),
  type: z.enum(['RETAIL', 'WHOLESALE', 'BOTH', 'WAREHOUSE']).default('BOTH'),
  gstin: gstinSchema.optional().or(z.literal('')),
  pan: panSchema.optional().or(z.literal('')),
  phone: indianMobileSchema.optional().or(z.literal('')),
  email: z.string().email().optional().or(z.literal('')),
  address: addressSchema,
  managerId: cuidSchema.optional(),
  openingDate: z.string().datetime().optional(),
  monthlyRent: rupeesSchema.optional(),
  areaSqft: z.coerce.number().int().min(0).optional(),
  invoicePrefix: z.string().trim().max(10).default('INV'),
  isActive: z.boolean().default(true),
  // 3D shop visualisation: floor plan footprint in metres
  floorWidth: z.coerce.number().min(0).optional(),
  floorDepth: z.coerce.number().min(0).optional(),
});

// ---------------------------------------------------------------------------
// Supplier
// ---------------------------------------------------------------------------

export const supplierSchema = z.object({
  code: z.string().trim().max(20).optional(),
  companyName: z.string().trim().min(2, 'Company name is required').max(200),
  ownerName: z.string().trim().max(150).optional().or(z.literal('')),
  gstin: gstinSchema.optional().or(z.literal('')),
  pan: panSchema.optional().or(z.literal('')),
  phone: indianMobileSchema,
  alternatePhone: indianMobileSchema.optional().or(z.literal('')),
  email: z.string().email().optional().or(z.literal('')),
  website: z.string().url().optional().or(z.literal('')),
  address: addressSchema,
  bankDetails: bankDetailsSchema.optional(),
  upiId: upiSchema.optional().or(z.literal('')),
  /** Days of credit allowed by this supplier */
  creditPeriodDays: z.coerce.number().int().min(0).max(365).default(0),
  creditLimit: rupeesSchema.optional(),
  openingBalance: signedRupeesSchema.default(0),
  category: z.string().trim().max(100).optional().or(z.literal('')),
  notes: z.string().max(2000).optional().or(z.literal('')),
  isActive: z.boolean().default(true),
});

// ---------------------------------------------------------------------------
// Product
// ---------------------------------------------------------------------------

export const productSchema = z.object({
  sku: z.string().trim().min(1, 'SKU is required').max(50).regex(/^[A-Za-z0-9._/-]+$/, 'SKU may contain letters, numbers . _ / -'),
  barcode: z.string().trim().max(50).optional().or(z.literal('')),
  name: z.string().trim().min(2, 'Product name is required').max(250),
  description: z.string().max(5000).optional().or(z.literal('')),
  categoryId: cuidSchema,
  subCategoryId: cuidSchema.optional(),
  brandId: cuidSchema.optional(),
  supplierId: cuidSchema.optional(),
  unitCode: z.string().trim().max(10).default('PCS'),
  hsnCode: z.string().trim().regex(/^\d{4}(\d{2})?(\d{2})?$/, 'HSN must be 4, 6 or 8 digits').optional().or(z.literal('')),
  gstRate: z.coerce.number().min(0).max(28).default(5),
  cessRate: z.coerce.number().min(0).max(100).default(0),

  // Textile attributes
  colour: z.string().trim().max(60).optional().or(z.literal('')),
  design: z.string().trim().max(100).optional().or(z.literal('')),
  pattern: z.string().trim().max(100).optional().or(z.literal('')),
  material: z.string().trim().max(100).optional().or(z.literal('')),
  fabric: z.string().trim().max(100).optional().or(z.literal('')),
  size: z.string().trim().max(40).optional().or(z.literal('')),
  lengthMtr: z.coerce.number().min(0).optional(),
  widthInch: z.coerce.number().min(0).optional(),
  weightGrams: z.coerce.number().min(0).optional(),
  season: z.enum(SEASONS).default('ALL_SEASON'),
  collection: z.string().trim().max(100).optional().or(z.literal('')),

  // Pricing (rupees in, paise stored)
  purchaseCost: rupeesSchema.default(0),
  sellingPrice: rupeesSchema.default(0),
  wholesalePrice: rupeesSchema.optional(),
  mrp: rupeesSchema.default(0),
  /** True when sellingPrice/MRP already include GST — normal for retail */
  priceIncludesTax: z.boolean().default(true),
  discountPercent: percentSchema.default(0),

  // Stock policy
  minStock: quantitySchema.default(0),
  maxStock: quantitySchema.optional(),
  reorderQuantity: quantitySchema.optional(),
  shelfLocation: z.string().trim().max(60).optional().or(z.literal('')),
  expiryDate: z.string().datetime().optional(),
  trackSerial: z.boolean().default(false),

  isActive: z.boolean().default(true),
})
  .refine((v) => v.mrp === 0 || v.sellingPrice <= v.mrp, {
    message: 'Selling price cannot exceed MRP — this is a legal requirement, not just a warning',
    path: ['sellingPrice'],
  })
  .refine((v) => v.maxStock === undefined || v.maxStock >= v.minStock, {
    message: 'Maximum stock must be greater than or equal to minimum stock',
    path: ['maxStock'],
  });

// ---------------------------------------------------------------------------
// Customer
// ---------------------------------------------------------------------------

export const customerSchema = z.object({
  code: z.string().trim().max(20).optional(),
  name: z.string().trim().min(2, 'Customer name is required').max(150),
  type: z.enum(CUSTOMER_TYPES).default('RETAIL'),
  phone: indianMobileSchema,
  alternatePhone: indianMobileSchema.optional().or(z.literal('')),
  email: z.string().email().optional().or(z.literal('')),
  gstin: gstinSchema.optional().or(z.literal('')),
  address: addressSchema.partial({ line1: true, city: true, pincode: true, stateCode: true }).optional(),
  /** Place of supply defaults to the customer's state; overridable for ship-to cases */
  placeOfSupplyStateCode: stateCodeSchema.optional(),
  birthday: z.string().datetime().optional(),
  anniversary: z.string().datetime().optional(),
  creditLimit: rupeesSchema.default(0),
  creditPeriodDays: z.coerce.number().int().min(0).max(365).default(0),
  openingBalance: signedRupeesSchema.default(0),
  loyaltyEnrolled: z.boolean().default(true),
  preferredContact: z.enum(['WHATSAPP', 'SMS', 'EMAIL', 'CALL', 'NONE']).default('WHATSAPP'),
  notes: z.string().max(2000).optional().or(z.literal('')),
  isActive: z.boolean().default(true),
});

// ---------------------------------------------------------------------------
// Sales
// ---------------------------------------------------------------------------

export const saleLineSchema = z.object({
  productId: cuidSchema,
  variantId: cuidSchema.optional(),
  description: z.string().max(250).optional(),
  quantity: z.coerce.number().positive('Quantity must be greater than zero'),
  unitPrice: rupeesSchema,
  discountPercent: percentSchema.default(0),
  discountAmount: rupeesSchema.default(0),
  /** Overrides the product's GST rate when set (rare — e.g. exempt supply) */
  gstRateOverride: z.coerce.number().min(0).max(28).optional(),
  serialNumbers: z.array(z.string()).optional(),
  notes: z.string().max(500).optional(),
});

export const paymentSplitSchema = z.object({
  mode: z.enum(PAYMENT_MODES),
  amount: rupeesSchema,
  reference: z.string().max(100).optional(),
  bankAccountId: cuidSchema.optional(),
});

export const saleSchema = z.object({
  shopId: cuidSchema,
  customerId: cuidSchema.optional(),
  /** Walk-in customers are billed without a customer record */
  walkInName: z.string().max(150).optional(),
  walkInPhone: indianMobileSchema.optional().or(z.literal('')),
  invoiceDate: z.string().datetime().optional(),
  dueDate: z.string().datetime().optional(),
  isWholesale: z.boolean().default(false),
  placeOfSupplyStateCode: stateCodeSchema.optional(),
  lines: z.array(saleLineSchema).min(1, 'Add at least one item to the bill'),
  invoiceDiscount: rupeesSchema.default(0),
  couponCode: z.string().max(40).optional(),
  loyaltyPointsRedeemed: z.coerce.number().int().min(0).default(0),
  payments: z.array(paymentSplitSchema).default([]),
  salespersonId: cuidSchema.optional(),
  notes: z.string().max(2000).optional(),
  /** Draft bills are held at the counter and do not affect stock or books */
  isDraft: z.boolean().default(false),
})
  .refine((v) => v.customerId || v.walkInName || !v.isWholesale, {
    message: 'Wholesale invoices require a registered customer',
    path: ['customerId'],
  });

// ---------------------------------------------------------------------------
// Purchase
// ---------------------------------------------------------------------------

export const purchaseLineSchema = z.object({
  productId: cuidSchema,
  variantId: cuidSchema.optional(),
  quantity: z.coerce.number().positive(),
  unitCost: rupeesSchema,
  discountPercent: percentSchema.default(0),
  discountAmount: rupeesSchema.default(0),
  gstRateOverride: z.coerce.number().min(0).max(28).optional(),
  expectedDate: z.string().datetime().optional(),
  notes: z.string().max(500).optional(),
});

export const purchaseOrderSchema = z.object({
  shopId: cuidSchema,
  supplierId: cuidSchema,
  orderDate: z.string().datetime().optional(),
  expectedDate: z.string().datetime().optional(),
  lines: z.array(purchaseLineSchema).min(1, 'Add at least one item to the order'),
  invoiceDiscount: rupeesSchema.default(0),
  freightCharges: rupeesSchema.default(0),
  notes: z.string().max(2000).optional(),
  termsAndConditions: z.string().max(5000).optional(),
});

export const goodsReceiptSchema = z.object({
  purchaseOrderId: cuidSchema.optional(),
  shopId: cuidSchema,
  supplierId: cuidSchema,
  receiptDate: z.string().datetime().optional(),
  supplierInvoiceNumber: z.string().max(60).optional(),
  supplierInvoiceDate: z.string().datetime().optional(),
  lines: z
    .array(
      purchaseLineSchema.extend({
        acceptedQuantity: z.coerce.number().min(0),
        rejectedQuantity: z.coerce.number().min(0).default(0),
        rejectionReason: z.string().max(300).optional(),
        batchNumber: z.string().max(60).optional(),
      }),
    )
    .min(1),
  notes: z.string().max(2000).optional(),
});

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

export const stockTransferSchema = z.object({
  fromShopId: cuidSchema,
  toShopId: cuidSchema,
  transferDate: z.string().datetime().optional(),
  lines: z
    .array(
      z.object({
        productId: cuidSchema,
        variantId: cuidSchema.optional(),
        quantity: z.coerce.number().positive(),
        notes: z.string().max(300).optional(),
      }),
    )
    .min(1, 'Add at least one item to transfer'),
  vehicleNumber: z.string().max(20).optional(),
  transporterName: z.string().max(150).optional(),
  notes: z.string().max(2000).optional(),
}).refine((v) => v.fromShopId !== v.toShopId, {
  message: 'Source and destination shops must be different',
  path: ['toShopId'],
});

export const stockAdjustmentSchema = z.object({
  shopId: cuidSchema,
  adjustmentDate: z.string().datetime().optional(),
  reason: z.enum(['DAMAGED', 'LOST', 'THEFT', 'EXPIRED', 'COUNT_CORRECTION', 'SAMPLE', 'GIFT', 'OTHER']),
  lines: z
    .array(
      z.object({
        productId: cuidSchema,
        variantId: cuidSchema.optional(),
        /** Signed: negative writes stock off, positive writes it on */
        quantityDelta: z.coerce.number().refine((n) => n !== 0, 'Adjustment cannot be zero'),
        notes: z.string().max(300).optional(),
      }),
    )
    .min(1),
  notes: z.string().max(2000).optional(),
});

// ---------------------------------------------------------------------------
// Accounting / expenses
// ---------------------------------------------------------------------------

export const accountSchema = z.object({
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(2).max(150),
  type: z.enum(ACCOUNT_TYPES),
  parentId: cuidSchema.optional(),
  description: z.string().max(1000).optional(),
  isBankAccount: z.boolean().default(false),
  isCashAccount: z.boolean().default(false),
  openingBalance: signedRupeesSchema.default(0),
  isActive: z.boolean().default(true),
});

export const journalEntrySchema = z.object({
  entryDate: z.string().datetime(),
  narration: z.string().min(3, 'Narration is required for audit purposes').max(1000),
  shopId: cuidSchema.optional(),
  referenceNumber: z.string().max(60).optional(),
  lines: z
    .array(
      z.object({
        accountId: cuidSchema,
        debit: rupeesSchema.default(0),
        credit: rupeesSchema.default(0),
        narration: z.string().max(500).optional(),
        costCentreId: cuidSchema.optional(),
      }),
    )
    .min(2, 'A journal entry needs at least two lines'),
})
  .refine(
    (v) => {
      const debit = v.lines.reduce((s, l) => s + Math.round(l.debit * 100), 0);
      const credit = v.lines.reduce((s, l) => s + Math.round(l.credit * 100), 0);
      return debit === credit;
    },
    { message: 'Total debit must equal total credit', path: ['lines'] },
  )
  .refine((v) => v.lines.every((l) => !(l.debit > 0 && l.credit > 0)), {
    message: 'A single line cannot carry both a debit and a credit',
    path: ['lines'],
  });

export const expenseSchema = z.object({
  shopId: cuidSchema.optional(),
  expenseDate: z.string().datetime(),
  categoryId: cuidSchema,
  amount: rupeesSchema.refine((n) => n > 0, 'Amount must be greater than zero'),
  gstRate: z.coerce.number().min(0).max(28).default(0),
  /** Input tax credit can be claimed on this expense */
  itcEligible: z.boolean().default(false),
  paymentMode: z.enum(PAYMENT_MODES).default('CASH'),
  paidFromAccountId: cuidSchema.optional(),
  vendorName: z.string().max(150).optional(),
  vendorGstin: gstinSchema.optional().or(z.literal('')),
  billNumber: z.string().max(60).optional(),
  description: z.string().max(1000).optional(),
  isRecurring: z.boolean().default(false),
  recurrence: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY']).optional(),
  recurrenceEndDate: z.string().datetime().optional(),
}).refine((v) => !v.isRecurring || !!v.recurrence, {
  message: 'Choose how often this expense repeats',
  path: ['recurrence'],
});

// ---------------------------------------------------------------------------
// Employee
// ---------------------------------------------------------------------------

export const employeeSchema = z.object({
  employeeCode: z.string().trim().max(20).optional(),
  name: z.string().trim().min(2).max(150),
  phone: indianMobileSchema,
  email: z.string().email().optional().or(z.literal('')),
  shopId: cuidSchema,
  designation: z.string().trim().max(100),
  department: z.string().trim().max(100).optional(),
  joiningDate: z.string().datetime(),
  monthlySalary: rupeesSchema,
  /** Commission on personal sales, % of net invoice value */
  commissionPercent: percentSchema.default(0),
  monthlyTarget: rupeesSchema.default(0),
  shiftStart: z.string().regex(/^\d{2}:\d{2}$/, 'Use HH:MM').optional(),
  shiftEnd: z.string().regex(/^\d{2}:\d{2}$/, 'Use HH:MM').optional(),
  pan: panSchema.optional().or(z.literal('')),
  aadhaarLast4: z.string().regex(/^\d{4}$/).optional().or(z.literal('')),
  bankDetails: bankDetailsSchema.optional(),
  address: addressSchema.partial().optional(),
  emergencyContact: indianMobileSchema.optional().or(z.literal('')),
  isActive: z.boolean().default(true),
});

export const attendanceSchema = z.object({
  employeeId: cuidSchema,
  date: z.string().datetime(),
  status: z.enum(['PRESENT', 'ABSENT', 'HALF_DAY', 'LEAVE', 'HOLIDAY', 'WEEK_OFF', 'LATE']),
  checkIn: z.string().datetime().optional(),
  checkOut: z.string().datetime().optional(),
  overtimeHours: z.coerce.number().min(0).max(24).default(0),
  notes: z.string().max(500).optional(),
});

// ---------------------------------------------------------------------------
// Reports / AI
// ---------------------------------------------------------------------------

export const reportRequestSchema = z.object({
  reportKey: z.string().min(1),
  period: z.enum(REPORT_PERIODS).default('THIS_MONTH'),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
  groupBy: z.enum(REPORT_GROUPINGS).default('NONE'),
  shopIds: z.array(cuidSchema).optional(),
  supplierIds: z.array(cuidSchema).optional(),
  categoryIds: z.array(cuidSchema).optional(),
  customerIds: z.array(cuidSchema).optional(),
  productIds: z.array(cuidSchema).optional(),
  compareWithPrevious: z.boolean().default(false),
  format: z.enum(EXPORT_FORMATS).optional(),
}).refine((v) => v.period !== 'CUSTOM' || (!!v.dateFrom && !!v.dateTo), {
  message: 'Custom period needs both a start and an end date',
  path: ['dateFrom'],
});

export const aiQuerySchema = z.object({
  message: z.string().trim().min(1, 'Ask a question').max(2000),
  conversationId: cuidSchema.optional(),
  shopId: cuidSchema.optional(),
  /** Voice input arrives already transcribed by the browser */
  source: z.enum(['TEXT', 'VOICE']).default('TEXT'),
});

export const valuationSettingsSchema = z.object({
  method: z.enum(VALUATION_METHODS).default('WEIGHTED_AVERAGE'),
});

// Re-export for convenience so consumers import types from one place.
export type ShopInput = z.infer<typeof shopSchema>;
export type SupplierInput = z.infer<typeof supplierSchema>;
export type ProductInput = z.infer<typeof productSchema>;
export type CustomerInput = z.infer<typeof customerSchema>;
export type SaleInput = z.infer<typeof saleSchema>;
export type PurchaseOrderInput = z.infer<typeof purchaseOrderSchema>;
export type GoodsReceiptInput = z.infer<typeof goodsReceiptSchema>;
export type StockTransferInput = z.infer<typeof stockTransferSchema>;
export type StockAdjustmentInput = z.infer<typeof stockAdjustmentSchema>;
export type JournalEntryInput = z.infer<typeof journalEntrySchema>;
export type ExpenseInput = z.infer<typeof expenseSchema>;
export type EmployeeInput = z.infer<typeof employeeSchema>;
export type ReportRequestInput = z.infer<typeof reportRequestSchema>;
export type AiQueryInput = z.infer<typeof aiQuerySchema>;
