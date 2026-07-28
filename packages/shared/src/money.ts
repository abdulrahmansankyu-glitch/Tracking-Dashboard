/**
 * Money handling.
 *
 * All monetary values crossing a module boundary are integers in **paise**
 * (1 rupee = 100 paise). Floating point rupees silently lose precision once you start
 * multiplying by tax rates and summing thousands of invoice lines — a ₹0.01 drift per
 * line becomes a trial balance that does not balance. Integers make that impossible.
 *
 * Persisted columns use Postgres NUMERIC(18,4) so the database stays human-readable and
 * exact; conversion happens at the edge via `toPaise` / `toRupees`.
 */

export type Paise = number;

/** Rupee amount (possibly fractional) → integer paise, half-up rounded. */
export function toPaise(rupees: number | string): Paise {
  const value = typeof rupees === 'string' ? Number.parseFloat(rupees) : rupees;
  if (!Number.isFinite(value)) return 0;
  // Scale then round half-away-from-zero. `Math.round` rounds -0.5 to -0, which
  // would break credit notes, so the sign is handled explicitly.
  const scaled = value * 100;
  return scaled < 0 ? -Math.round(Math.abs(scaled)) : Math.round(scaled);
}

/** Integer paise → rupees as a number. Use only for display/serialisation. */
export function toRupees(paise: Paise): number {
  return paise / 100;
}

/** Multiply paise by a plain factor (e.g. quantity), returning rounded paise. */
export function mulPaise(paise: Paise, factor: number): Paise {
  const result = paise * factor;
  return result < 0 ? -Math.round(Math.abs(result)) : Math.round(result);
}

/** Apply a percentage (e.g. 12 for 12%) to a paise amount. */
export function percentOf(paise: Paise, percent: number): Paise {
  return mulPaise(paise, percent / 100);
}

/** Sum a list of paise amounts. */
export function sumPaise(values: readonly Paise[]): Paise {
  return values.reduce<Paise>((acc, v) => acc + v, 0);
}

/**
 * Indian invoice round-off: the grand total is rounded to the nearest rupee and the
 * difference is posted to a "Round Off" ledger. Returns both parts.
 */
export function roundOffToRupee(paise: Paise): { rounded: Paise; adjustment: Paise } {
  const remainder = paise % 100;
  let rounded: Paise;
  if (remainder === 0) {
    rounded = paise;
  } else if (Math.abs(remainder) < 50) {
    rounded = paise - remainder;
  } else {
    rounded = paise + (remainder > 0 ? 100 - remainder : -100 - remainder);
  }
  return { rounded, adjustment: rounded - paise };
}

const INR_FORMATTER = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Format paise as "₹1,23,456.78" using the Indian digit grouping system. */
export function formatINR(paise: Paise): string {
  return INR_FORMATTER.format(toRupees(paise));
}

/** Compact form for dashboard tiles: ₹1.2L, ₹3.4Cr — the units Indian owners actually use. */
export function formatINRCompact(paise: Paise): string {
  const rupees = toRupees(paise);
  const abs = Math.abs(rupees);
  const sign = rupees < 0 ? '-' : '';
  if (abs >= 1_00_00_000) return `${sign}₹${(abs / 1_00_00_000).toFixed(2)}Cr`;
  if (abs >= 1_00_000) return `${sign}₹${(abs / 1_00_000).toFixed(2)}L`;
  if (abs >= 1_000) return `${sign}₹${(abs / 1_000).toFixed(1)}K`;
  return `${sign}₹${abs.toFixed(0)}`;
}

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen',
  'Eighteen', 'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function twoDigitsToWords(n: number): string {
  if (n < 20) return ONES[n] ?? '';
  const tens = TENS[Math.floor(n / 10)] ?? '';
  const ones = ONES[n % 10] ?? '';
  return ones ? `${tens} ${ones}` : tens;
}

/**
 * Amount in words, Indian numbering system — a legal requirement on GST tax invoices.
 * e.g. 123456789 paise → "Rupees Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven and Eighty Nine Paise Only"
 */
export function amountInWords(paise: Paise): string {
  if (paise === 0) return 'Rupees Zero Only';
  const negative = paise < 0;
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const fraction = abs % 100;

  const parts: string[] = [];
  const crore = Math.floor(rupees / 1_00_00_000);
  const lakh = Math.floor((rupees % 1_00_00_000) / 1_00_000);
  const thousand = Math.floor((rupees % 1_00_000) / 1_000);
  const hundred = Math.floor((rupees % 1_000) / 100);
  const rest = rupees % 100;

  if (crore) parts.push(`${twoDigitsToWords(crore)} Crore`);
  if (lakh) parts.push(`${twoDigitsToWords(lakh)} Lakh`);
  if (thousand) parts.push(`${twoDigitsToWords(thousand)} Thousand`);
  if (hundred) parts.push(`${ONES[hundred]} Hundred`);
  if (rest) parts.push(twoDigitsToWords(rest));

  let words = `Rupees ${parts.join(' ')}`;
  if (fraction) words += ` and ${twoDigitsToWords(fraction)} Paise`;
  return `${negative ? 'Minus ' : ''}${words} Only`;
}
