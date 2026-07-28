/**
 * India-specific reference data: GST state codes, GST slabs and textile HSN codes.
 *
 * The state code is the first two digits of a GSTIN and is what decides whether a
 * transaction is intra-state (CGST + SGST) or inter-state (IGST). Getting this table
 * right is the difference between a compliant GSTR-1 and a rejected one.
 */

export interface IndianState {
  /** Two digit GST state code, e.g. "09" for Uttar Pradesh */
  readonly code: string;
  readonly name: string;
  /** ISO 3166-2:IN subdivision code */
  readonly iso: string;
  readonly type: 'state' | 'union-territory';
}

export const INDIAN_STATES: readonly IndianState[] = [
  { code: '01', name: 'Jammu and Kashmir', iso: 'JK', type: 'union-territory' },
  { code: '02', name: 'Himachal Pradesh', iso: 'HP', type: 'state' },
  { code: '03', name: 'Punjab', iso: 'PB', type: 'state' },
  { code: '04', name: 'Chandigarh', iso: 'CH', type: 'union-territory' },
  { code: '05', name: 'Uttarakhand', iso: 'UT', type: 'state' },
  { code: '06', name: 'Haryana', iso: 'HR', type: 'state' },
  { code: '07', name: 'Delhi', iso: 'DL', type: 'union-territory' },
  { code: '08', name: 'Rajasthan', iso: 'RJ', type: 'state' },
  { code: '09', name: 'Uttar Pradesh', iso: 'UP', type: 'state' },
  { code: '10', name: 'Bihar', iso: 'BR', type: 'state' },
  { code: '11', name: 'Sikkim', iso: 'SK', type: 'state' },
  { code: '12', name: 'Arunachal Pradesh', iso: 'AR', type: 'state' },
  { code: '13', name: 'Nagaland', iso: 'NL', type: 'state' },
  { code: '14', name: 'Manipur', iso: 'MN', type: 'state' },
  { code: '15', name: 'Mizoram', iso: 'MZ', type: 'state' },
  { code: '16', name: 'Tripura', iso: 'TR', type: 'state' },
  { code: '17', name: 'Meghalaya', iso: 'ML', type: 'state' },
  { code: '18', name: 'Assam', iso: 'AS', type: 'state' },
  { code: '19', name: 'West Bengal', iso: 'WB', type: 'state' },
  { code: '20', name: 'Jharkhand', iso: 'JH', type: 'state' },
  { code: '21', name: 'Odisha', iso: 'OR', type: 'state' },
  { code: '22', name: 'Chhattisgarh', iso: 'CT', type: 'state' },
  { code: '23', name: 'Madhya Pradesh', iso: 'MP', type: 'state' },
  { code: '24', name: 'Gujarat', iso: 'GJ', type: 'state' },
  { code: '26', name: 'Dadra and Nagar Haveli and Daman and Diu', iso: 'DH', type: 'union-territory' },
  { code: '27', name: 'Maharashtra', iso: 'MH', type: 'state' },
  { code: '29', name: 'Karnataka', iso: 'KA', type: 'state' },
  { code: '30', name: 'Goa', iso: 'GA', type: 'state' },
  { code: '31', name: 'Lakshadweep', iso: 'LD', type: 'union-territory' },
  { code: '32', name: 'Kerala', iso: 'KL', type: 'state' },
  { code: '33', name: 'Tamil Nadu', iso: 'TN', type: 'state' },
  { code: '34', name: 'Puducherry', iso: 'PY', type: 'union-territory' },
  { code: '35', name: 'Andaman and Nicobar Islands', iso: 'AN', type: 'union-territory' },
  { code: '36', name: 'Telangana', iso: 'TG', type: 'state' },
  { code: '37', name: 'Andhra Pradesh', iso: 'AP', type: 'state' },
  { code: '38', name: 'Ladakh', iso: 'LA', type: 'union-territory' },
  { code: '97', name: 'Other Territory', iso: 'OT', type: 'union-territory' },
  { code: '99', name: 'Centre Jurisdiction', iso: 'CJ', type: 'union-territory' },
] as const;

export const STATE_BY_CODE: ReadonlyMap<string, IndianState> = new Map(
  INDIAN_STATES.map((s) => [s.code, s]),
);

export function getStateByCode(code: string): IndianState | undefined {
  return STATE_BY_CODE.get(code);
}

/** GST rate slabs currently applicable in India. */
export const GST_SLABS = [0, 0.25, 3, 5, 12, 18, 28] as const;
export type GstSlab = (typeof GST_SLABS)[number];

/**
 * HSN codes relevant to a clothing wholesale + retail business.
 *
 * Textile GST is value-dependent: apparel with a sale value up to ₹1,000 per piece is
 * taxed at 5%, above that at 12%. `thresholdAmount`/`rateAbove` encode that rule so the
 * tax engine can resolve the correct slab per line item instead of hard-coding one rate.
 */
export interface HsnCode {
  readonly code: string;
  readonly description: string;
  /** Default GST rate (%) at or below the threshold */
  readonly rate: number;
  /** Per-unit value above which `rateAbove` applies (INR). Null = flat rate. */
  readonly thresholdAmount: number | null;
  /** Rate (%) applied above the threshold */
  readonly rateAbove: number | null;
  readonly category: string;
}

export const TEXTILE_HSN_CODES: readonly HsnCode[] = [
  // --- Fabrics / rolls (sold by metre, flat 5%) ---
  { code: '5007', description: 'Woven fabrics of silk or of silk waste', rate: 5, thresholdAmount: null, rateAbove: null, category: 'Fabric' },
  { code: '5111', description: 'Woven fabrics of carded wool', rate: 5, thresholdAmount: null, rateAbove: null, category: 'Fabric' },
  { code: '5112', description: 'Woven fabrics of combed wool', rate: 5, thresholdAmount: null, rateAbove: null, category: 'Fabric' },
  { code: '5208', description: 'Woven fabrics of cotton, >= 85% cotton, <= 200 g/m2', rate: 5, thresholdAmount: null, rateAbove: null, category: 'Fabric' },
  { code: '5209', description: 'Woven fabrics of cotton, >= 85% cotton, > 200 g/m2', rate: 5, thresholdAmount: null, rateAbove: null, category: 'Fabric' },
  { code: '5407', description: 'Woven fabrics of synthetic filament yarn', rate: 5, thresholdAmount: null, rateAbove: null, category: 'Fabric' },
  { code: '5408', description: 'Woven fabrics of artificial filament yarn', rate: 5, thresholdAmount: null, rateAbove: null, category: 'Fabric' },
  { code: '5512', description: 'Woven fabrics of synthetic staple fibres', rate: 5, thresholdAmount: null, rateAbove: null, category: 'Fabric' },
  { code: '5801', description: 'Woven pile fabrics and chenille fabrics', rate: 5, thresholdAmount: null, rateAbove: null, category: 'Fabric' },

  // --- Knitted / crocheted apparel (value-dependent 5% / 12%) ---
  { code: '6101', description: "Men's or boys' overcoats, anoraks (knitted)", rate: 5, thresholdAmount: 1000, rateAbove: 12, category: 'Men Wear' },
  { code: '6102', description: "Women's or girls' overcoats, anoraks (knitted)", rate: 5, thresholdAmount: 1000, rateAbove: 12, category: 'Ladies Wear' },
  { code: '6103', description: "Men's or boys' suits, jackets, trousers (knitted)", rate: 5, thresholdAmount: 1000, rateAbove: 12, category: 'Men Wear' },
  { code: '6104', description: "Women's or girls' suits, dresses, skirts (knitted)", rate: 5, thresholdAmount: 1000, rateAbove: 12, category: 'Ladies Wear' },
  { code: '6105', description: "Men's or boys' shirts (knitted)", rate: 5, thresholdAmount: 1000, rateAbove: 12, category: 'Men Wear' },
  { code: '6106', description: "Women's or girls' blouses, shirts (knitted)", rate: 5, thresholdAmount: 1000, rateAbove: 12, category: 'Ladies Wear' },
  { code: '6109', description: 'T-shirts, singlets and other vests (knitted)', rate: 5, thresholdAmount: 1000, rateAbove: 12, category: 'Men Wear' },
  { code: '6110', description: 'Jerseys, pullovers, cardigans, waistcoats (knitted)', rate: 5, thresholdAmount: 1000, rateAbove: 12, category: 'Winter Wear' },
  { code: '6111', description: "Babies' garments and clothing accessories (knitted)", rate: 5, thresholdAmount: 1000, rateAbove: 12, category: 'Children Wear' },

  // --- Woven apparel (value-dependent 5% / 12%) ---
  { code: '6201', description: "Men's or boys' overcoats, anoraks (woven)", rate: 5, thresholdAmount: 1000, rateAbove: 12, category: 'Men Wear' },
  { code: '6202', description: "Women's or girls' overcoats, anoraks (woven)", rate: 5, thresholdAmount: 1000, rateAbove: 12, category: 'Ladies Wear' },
  { code: '6203', description: "Men's or boys' suits, jackets, trousers (woven) — Sherwani, Groom Sets, Pant", rate: 5, thresholdAmount: 1000, rateAbove: 12, category: 'Men Wear' },
  { code: '6204', description: "Women's or girls' suits, dresses, skirts (woven)", rate: 5, thresholdAmount: 1000, rateAbove: 12, category: 'Ladies Wear' },
  { code: '6205', description: "Men's or boys' shirts (woven)", rate: 5, thresholdAmount: 1000, rateAbove: 12, category: 'Men Wear' },
  { code: '6206', description: "Women's or girls' blouses, shirts (woven)", rate: 5, thresholdAmount: 1000, rateAbove: 12, category: 'Ladies Wear' },
  { code: '6207', description: "Men's or boys' singlets, underpants, pyjamas — Kurta Pajama", rate: 5, thresholdAmount: 1000, rateAbove: 12, category: 'Men Wear' },
  { code: '6208', description: "Women's or girls' singlets, slips, nightdresses", rate: 5, thresholdAmount: 1000, rateAbove: 12, category: 'Ladies Wear' },
  { code: '6209', description: "Babies' garments and clothing accessories (woven)", rate: 5, thresholdAmount: 1000, rateAbove: 12, category: 'Children Wear' },
  { code: '6211', description: 'Track suits, ski suits and swimwear; other garments', rate: 5, thresholdAmount: 1000, rateAbove: 12, category: 'Men Wear' },
  { code: '6214', description: 'Shawls, scarves, mufflers, mantillas, veils — Kashmiri Shawls, Stoles', rate: 5, thresholdAmount: 1000, rateAbove: 12, category: 'Accessories' },
  { code: '6217', description: 'Other made up clothing accessories', rate: 5, thresholdAmount: 1000, rateAbove: 12, category: 'Accessories' },

  // --- Sarees & made-ups ---
  { code: '5407', description: 'Sarees of synthetic filament yarn', rate: 5, thresholdAmount: null, rateAbove: null, category: 'Saree' },
  { code: '6211', description: 'Sarees — made up garments', rate: 5, thresholdAmount: 1000, rateAbove: 12, category: 'Saree' },
  { code: '6301', description: 'Blankets and travelling rugs', rate: 5, thresholdAmount: 1000, rateAbove: 12, category: 'Blankets' },
  { code: '6302', description: 'Bed linen, table linen, toilet and kitchen linen', rate: 5, thresholdAmount: 1000, rateAbove: 12, category: 'Home Textile' },
  { code: '6305', description: 'Sacks and bags of a kind used for packing of goods', rate: 5, thresholdAmount: null, rateAbove: null, category: 'Packing' },

  // --- Non-textile accessories ---
  { code: '4202', description: 'Trunks, suitcases, handbags, wallets', rate: 18, thresholdAmount: null, rateAbove: null, category: 'Accessories' },
  { code: '6403', description: 'Footwear with outer soles of leather', rate: 12, thresholdAmount: 1000, rateAbove: 18, category: 'Footwear' },
  { code: '7117', description: 'Imitation jewellery', rate: 3, thresholdAmount: null, rateAbove: null, category: 'Accessories' },
] as const;

/** Units of measure used across products, matching the GST UQC (Unique Quantity Code) list. */
export const UNITS_OF_MEASURE = [
  { code: 'PCS', name: 'Pieces', uqc: 'PCS' },
  { code: 'MTR', name: 'Metres', uqc: 'MTR' },
  { code: 'NOS', name: 'Numbers', uqc: 'NOS' },
  { code: 'KGS', name: 'Kilograms', uqc: 'KGS' },
  { code: 'SET', name: 'Sets', uqc: 'SET' },
  { code: 'PAC', name: 'Packs', uqc: 'PAC' },
  { code: 'BOX', name: 'Box', uqc: 'BOX' },
  { code: 'ROL', name: 'Rolls', uqc: 'ROL' },
  { code: 'DOZ', name: 'Dozen', uqc: 'DOZ' },
  { code: 'BDL', name: 'Bundles', uqc: 'BDL' },
  { code: 'THD', name: 'Thousands', uqc: 'THD' },
] as const;

/** Indian financial year runs 1 April → 31 March. */
export const FINANCIAL_YEAR_START_MONTH = 4;

export const CURRENCY = {
  code: 'INR',
  symbol: '₹',
  locale: 'en-IN',
  decimals: 2,
} as const;
