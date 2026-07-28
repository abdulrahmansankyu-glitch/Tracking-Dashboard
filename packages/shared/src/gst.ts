/**
 * GST engine — the single source of truth for Indian tax computation.
 *
 * Both the POS (which must show a live total as the cashier scans) and the API (which
 * writes the legally binding invoice) call these functions, so a bill can never show one
 * number and file another.
 *
 * Rules implemented:
 *  1. Place of supply decides the tax split. Supplier state === place of supply →
 *     CGST + SGST, each at half the rate. Otherwise → IGST at the full rate.
 *  2. Textile apparel is value-dependent: <= ₹1,000 per piece is 5%, above is 12%.
 *     The threshold applies to the *taxable value per unit after discount*.
 *  3. Prices may be quoted tax-inclusive (retail MRP) or tax-exclusive (wholesale).
 *  4. Discounts recorded on the invoice reduce the taxable value; post-sale discounts
 *     not linked to the invoice do not (handled by credit note instead).
 *  5. The invoice grand total is rounded to the nearest rupee, with the difference
 *     posted to a Round Off ledger.
 */

import { TEXTILE_HSN_CODES } from './constants/india';
import { mulPaise, percentOf, roundOffToRupee, sumPaise, toPaise, type Paise } from './money';

export type SupplyType = 'INTRA_STATE' | 'INTER_STATE';

export interface GstRateResolution {
  readonly rate: number;
  readonly reason: string;
}

/**
 * Resolve the applicable GST rate for an HSN code given the per-unit taxable value.
 * Falls back to the explicit rate on the product when the HSN is unknown to us.
 */
export function resolveGstRate(
  hsnCode: string | null | undefined,
  perUnitTaxableValue: Paise,
  fallbackRate: number,
): GstRateResolution {
  if (!hsnCode) {
    return { rate: fallbackRate, reason: 'No HSN code — using product default rate' };
  }
  // HSN may be recorded at 4, 6 or 8 digits; match on the longest known prefix.
  const candidates = TEXTILE_HSN_CODES.filter((h) => hsnCode.startsWith(h.code));
  const entry = candidates.sort((a, b) => b.code.length - a.code.length)[0];
  if (!entry) {
    return { rate: fallbackRate, reason: `HSN ${hsnCode} not in reference table — using product rate` };
  }
  if (entry.thresholdAmount !== null && entry.rateAbove !== null) {
    const thresholdPaise = toPaise(entry.thresholdAmount);
    if (perUnitTaxableValue > thresholdPaise) {
      return {
        rate: entry.rateAbove,
        reason: `HSN ${entry.code}: unit value above ₹${entry.thresholdAmount} → ${entry.rateAbove}%`,
      };
    }
    return {
      rate: entry.rate,
      reason: `HSN ${entry.code}: unit value at or below ₹${entry.thresholdAmount} → ${entry.rate}%`,
    };
  }
  return { rate: entry.rate, reason: `HSN ${entry.code}: flat ${entry.rate}%` };
}

export interface TaxLineInput {
  readonly lineId?: string;
  readonly description?: string;
  readonly hsnCode?: string | null;
  readonly quantity: number;
  /** Rate per unit in paise, as quoted */
  readonly unitPrice: Paise;
  /** Flat discount on the line in paise (applied before tax) */
  readonly discountAmount?: Paise;
  /** Percentage discount on the line, alternative to discountAmount */
  readonly discountPercent?: number;
  /** GST % to use when the HSN table cannot resolve one */
  readonly gstRate: number;
  /** Compensation cess %, if any */
  readonly cessRate?: number;
  /** True when unitPrice already includes GST (retail MRP billing) */
  readonly taxInclusive?: boolean;
}

export interface TaxLineResult {
  readonly lineId?: string;
  readonly description?: string;
  readonly hsnCode: string | null;
  readonly quantity: number;
  readonly unitPrice: Paise;
  /** quantity × unitPrice, before discount */
  readonly grossAmount: Paise;
  readonly discountAmount: Paise;
  /** Value GST is charged on */
  readonly taxableValue: Paise;
  readonly gstRate: number;
  readonly rateReason: string;
  readonly cgst: Paise;
  readonly sgst: Paise;
  readonly igst: Paise;
  readonly cess: Paise;
  readonly totalTax: Paise;
  /** taxableValue + totalTax */
  readonly lineTotal: Paise;
}

export interface TaxTotals {
  readonly grossAmount: Paise;
  readonly totalDiscount: Paise;
  readonly taxableValue: Paise;
  readonly cgst: Paise;
  readonly sgst: Paise;
  readonly igst: Paise;
  readonly cess: Paise;
  readonly totalTax: Paise;
  /** Before round-off */
  readonly subTotal: Paise;
  readonly roundOff: Paise;
  /** Final payable, rounded to the rupee */
  readonly grandTotal: Paise;
}

export interface TaxComputation {
  readonly supplyType: SupplyType;
  readonly lines: readonly TaxLineResult[];
  readonly totals: TaxTotals;
  /** Rate-wise breakup, as required in the GSTR-1 HSN summary */
  readonly rateSummary: readonly RateSummaryRow[];
}

export interface RateSummaryRow {
  readonly gstRate: number;
  readonly taxableValue: Paise;
  readonly cgst: Paise;
  readonly sgst: Paise;
  readonly igst: Paise;
  readonly cess: Paise;
}

export interface TaxComputationOptions {
  /** GST state code of the supplying shop, e.g. "09" */
  readonly supplierStateCode: string;
  /** GST state code of the place of supply (customer's state) */
  readonly placeOfSupplyStateCode: string;
  /** Invoice-level discount in paise, apportioned across lines by taxable value */
  readonly invoiceDiscount?: Paise;
  /** Skip the nearest-rupee rounding (e.g. for credit notes matched to an original) */
  readonly skipRoundOff?: boolean;
}

export function determineSupplyType(
  supplierStateCode: string,
  placeOfSupplyStateCode: string,
): SupplyType {
  return supplierStateCode === placeOfSupplyStateCode ? 'INTRA_STATE' : 'INTER_STATE';
}

/**
 * Compute tax for a full document (sales invoice, purchase bill, credit note...).
 *
 * Invoice-level discount is apportioned across lines in proportion to their taxable
 * value, because GST must be reduced on the specific lines it relates to — you cannot
 * simply subtract it from the grand total and keep the tax unchanged.
 */
export function computeTax(
  inputLines: readonly TaxLineInput[],
  options: TaxComputationOptions,
): TaxComputation {
  const supplyType = determineSupplyType(
    options.supplierStateCode,
    options.placeOfSupplyStateCode,
  );

  // --- Pass 1: gross, line discount, and pre-apportionment taxable value ---
  interface Stage1 {
    input: TaxLineInput;
    grossAmount: Paise;
    lineDiscount: Paise;
    /** Taxable value before invoice-level discount; for inclusive pricing this still
     *  contains tax and is corrected in pass 3. */
    preTaxable: Paise;
  }

  const stage1: Stage1[] = inputLines.map((line) => {
    const grossAmount = mulPaise(line.unitPrice, line.quantity);
    const lineDiscount =
      line.discountAmount ??
      (line.discountPercent ? percentOf(grossAmount, line.discountPercent) : 0);
    return {
      input: line,
      grossAmount,
      lineDiscount,
      preTaxable: Math.max(0, grossAmount - lineDiscount),
    };
  });

  // --- Pass 2: apportion the invoice-level discount ---
  const invoiceDiscount = options.invoiceDiscount ?? 0;
  const basisTotal = sumPaise(stage1.map((s) => s.preTaxable));
  let apportionedSoFar = 0;

  const stage2 = stage1.map((s, index) => {
    let share = 0;
    if (invoiceDiscount > 0 && basisTotal > 0) {
      if (index === stage1.length - 1) {
        // Last line absorbs the rounding remainder so the apportionment sums exactly.
        share = invoiceDiscount - apportionedSoFar;
      } else {
        share = Math.round((invoiceDiscount * s.preTaxable) / basisTotal);
        apportionedSoFar += share;
      }
    }
    return { ...s, invoiceDiscountShare: share, netValue: Math.max(0, s.preTaxable - share) };
  });

  // --- Pass 3: resolve rate and split the tax ---
  const lines: TaxLineResult[] = stage2.map((s) => {
    const { input } = s;
    const taxInclusive = input.taxInclusive ?? false;
    const cessRate = input.cessRate ?? 0;

    // For inclusive pricing the rate must be resolved from the tax-exclusive unit value,
    // but that value depends on the rate. Resolve with the quoted price first (a safe
    // over-estimate), then back out the base and re-resolve once. One correction is
    // enough because the slabs are far apart relative to the tax fraction.
    const provisionalPerUnit = input.quantity > 0 ? Math.round(s.netValue / input.quantity) : 0;
    let resolution = resolveGstRate(input.hsnCode, provisionalPerUnit, input.gstRate);

    let taxableValue: Paise;
    if (taxInclusive) {
      const divisor = 1 + (resolution.rate + cessRate) / 100;
      taxableValue = Math.round(s.netValue / divisor);
      const perUnitExclusive = input.quantity > 0 ? Math.round(taxableValue / input.quantity) : 0;
      const corrected = resolveGstRate(input.hsnCode, perUnitExclusive, input.gstRate);
      if (corrected.rate !== resolution.rate) {
        resolution = corrected;
        const correctedDivisor = 1 + (corrected.rate + cessRate) / 100;
        taxableValue = Math.round(s.netValue / correctedDivisor);
      }
    } else {
      taxableValue = s.netValue;
    }

    const totalGst = percentOf(taxableValue, resolution.rate);
    let cgst = 0;
    let sgst = 0;
    let igst = 0;
    if (supplyType === 'INTRA_STATE') {
      // Halve deterministically: SGST takes the remainder so cgst + sgst === totalGst.
      cgst = Math.round(totalGst / 2);
      sgst = totalGst - cgst;
    } else {
      igst = totalGst;
    }
    const cess = cessRate ? percentOf(taxableValue, cessRate) : 0;
    const totalTax = cgst + sgst + igst + cess;

    return {
      lineId: input.lineId,
      description: input.description,
      hsnCode: input.hsnCode ?? null,
      quantity: input.quantity,
      unitPrice: input.unitPrice,
      grossAmount: s.grossAmount,
      discountAmount: s.lineDiscount + s.invoiceDiscountShare,
      taxableValue,
      gstRate: resolution.rate,
      rateReason: resolution.reason,
      cgst,
      sgst,
      igst,
      cess,
      totalTax,
      lineTotal: taxableValue + totalTax,
    };
  });

  // --- Totals ---
  const grossAmount = sumPaise(lines.map((l) => l.grossAmount));
  const totalDiscount = sumPaise(lines.map((l) => l.discountAmount));
  const taxableValue = sumPaise(lines.map((l) => l.taxableValue));
  const cgst = sumPaise(lines.map((l) => l.cgst));
  const sgst = sumPaise(lines.map((l) => l.sgst));
  const igst = sumPaise(lines.map((l) => l.igst));
  const cess = sumPaise(lines.map((l) => l.cess));
  const totalTax = cgst + sgst + igst + cess;
  const subTotal = taxableValue + totalTax;
  const { rounded, adjustment } = options.skipRoundOff
    ? { rounded: subTotal, adjustment: 0 }
    : roundOffToRupee(subTotal);

  // --- Rate-wise summary for GSTR-1 ---
  const byRate = new Map<number, RateSummaryRow>();
  for (const line of lines) {
    const existing = byRate.get(line.gstRate);
    byRate.set(line.gstRate, {
      gstRate: line.gstRate,
      taxableValue: (existing?.taxableValue ?? 0) + line.taxableValue,
      cgst: (existing?.cgst ?? 0) + line.cgst,
      sgst: (existing?.sgst ?? 0) + line.sgst,
      igst: (existing?.igst ?? 0) + line.igst,
      cess: (existing?.cess ?? 0) + line.cess,
    });
  }

  return {
    supplyType,
    lines,
    totals: {
      grossAmount,
      totalDiscount,
      taxableValue,
      cgst,
      sgst,
      igst,
      cess,
      totalTax,
      subTotal,
      roundOff: adjustment,
      grandTotal: rounded,
    },
    rateSummary: [...byRate.values()].sort((a, b) => a.gstRate - b.gstRate),
  };
}

// ---------------------------------------------------------------------------
// GSTIN validation
// ---------------------------------------------------------------------------

const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
const GSTIN_CHECKSUM_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Validate a GSTIN including its check digit.
 *
 * Format: 2 state code + 10 PAN + 1 entity number + "Z" + 1 checksum.
 * The checksum uses a modified Luhn over base-36 with alternating weights 1 and 2.
 */
export function isValidGstin(gstin: string): boolean {
  if (!gstin || gstin.length !== 15) return false;
  const value = gstin.toUpperCase();
  if (!GSTIN_REGEX.test(value)) return false;
  // State code must be one we recognise.
  const stateCode = value.slice(0, 2);
  if (Number.parseInt(stateCode, 10) < 1) return false;

  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const char = value[i];
    if (char === undefined) return false;
    const codePoint = GSTIN_CHECKSUM_ALPHABET.indexOf(char);
    if (codePoint < 0) return false;
    const weight = i % 2 === 0 ? 1 : 2;
    const product = codePoint * weight;
    sum += Math.floor(product / 36) + (product % 36);
  }
  const expected = (36 - (sum % 36)) % 36;
  return GSTIN_CHECKSUM_ALPHABET[expected] === value[14];
}

/** Extract the state code from a GSTIN, or null when malformed. */
export function stateCodeFromGstin(gstin: string | null | undefined): string | null {
  if (!gstin || gstin.length < 2) return null;
  return gstin.slice(0, 2);
}

/** Extract the embedded PAN (characters 3–12) from a GSTIN. */
export function panFromGstin(gstin: string | null | undefined): string | null {
  if (!gstin || gstin.length !== 15) return null;
  return gstin.slice(2, 12);
}

const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

export function isValidPan(pan: string): boolean {
  return PAN_REGEX.test(pan?.toUpperCase() ?? '');
}

const IFSC_REGEX = /^[A-Z]{4}0[A-Z0-9]{6}$/;

export function isValidIfsc(ifsc: string): boolean {
  return IFSC_REGEX.test(ifsc?.toUpperCase() ?? '');
}

const UPI_REGEX = /^[\w.\-]{2,256}@[a-zA-Z]{2,64}$/;

export function isValidUpiId(upi: string): boolean {
  return UPI_REGEX.test(upi ?? '');
}

/** Indian mobile numbers: 10 digits starting 6–9, optional +91 / 0 prefix. */
const INDIAN_MOBILE_REGEX = /^(?:\+?91[-\s]?|0)?[6-9]\d{9}$/;

export function isValidIndianMobile(phone: string): boolean {
  return INDIAN_MOBILE_REGEX.test((phone ?? '').replace(/[\s-]/g, ''));
}

/** Normalise any accepted mobile format to bare 10 digits for storage. */
export function normaliseIndianMobile(phone: string): string | null {
  const digits = (phone ?? '').replace(/\D/g, '');
  const last10 = digits.slice(-10);
  return /^[6-9]\d{9}$/.test(last10) ? last10 : null;
}
