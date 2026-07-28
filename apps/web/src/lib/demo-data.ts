/**
 * SAMPLE DATA — placeholder only.
 *
 * The dashboard is built against this shape so the layout, charts and 3D view can be
 * reviewed before the sales, inventory and accounting modules land. Every figure here
 * is invented. Replace the `useDashboard` hook's source with `/dashboard/summary` once
 * that endpoint exists; the component contracts do not change.
 *
 * Money is in rupees (not paise) because these values never round-trip through the
 * tax engine — they are display fixtures.
 */

export interface DashboardKpi {
  label: string;
  value: number;
  format: 'currency' | 'number' | 'percent';
  changePercent?: number;
  higherIsBetter?: boolean;
  subtitle?: string;
  sparkline?: number[];
}

export interface SalesTrendPoint {
  date: string;
  retail: number;
  wholesale: number;
}

export interface ShopPerformance {
  id: string;
  code: string;
  name: string;
  sales: number;
  profit: number;
  target: number;
  stockValue: number;
}

export interface TopProduct {
  name: string;
  category: string;
  quantity: number;
  revenue: number;
}

export interface StockAlert {
  id: string;
  severity: 'CRITICAL' | 'WARNING' | 'INFO';
  product: string;
  shop: string;
  currentStock: number;
  minStock: number;
}

export const DEMO_KPIS: DashboardKpi[] = [
  { label: "Today's Sales", value: 184_500, format: 'currency', changePercent: 12.4, subtitle: 'vs yesterday', sparkline: [120, 132, 118, 145, 160, 152, 184] },
  { label: "Today's Profit", value: 47_200, format: 'currency', changePercent: 8.1, subtitle: 'vs yesterday', sparkline: [32, 35, 30, 38, 41, 39, 47] },
  { label: 'Monthly Sales', value: 38_40_000, format: 'currency', changePercent: 5.6, subtitle: 'vs last month' },
  { label: 'Monthly Profit', value: 9_72_000, format: 'currency', changePercent: -2.3, subtitle: 'vs last month' },
  { label: 'Stock Value', value: 1_24_50_000, format: 'currency', changePercent: 3.1, subtitle: 'across 3 shops' },
  { label: 'Receivables', value: 8_65_000, format: 'currency', changePercent: 14.2, higherIsBetter: false, subtitle: '₹2.1L overdue' },
  { label: 'Payables', value: 12_40_000, format: 'currency', changePercent: -6.8, higherIsBetter: false, subtitle: 'due in 30 days' },
  { label: 'Cash Balance', value: 3_18_000, format: 'currency', changePercent: 1.2, subtitle: 'cash + bank' },
];

export const DEMO_SALES_TREND: SalesTrendPoint[] = [
  { date: '01 Jul', retail: 92_000, wholesale: 148_000 },
  { date: '05 Jul', retail: 108_000, wholesale: 132_000 },
  { date: '09 Jul', retail: 86_000, wholesale: 176_000 },
  { date: '13 Jul', retail: 124_000, wholesale: 154_000 },
  { date: '17 Jul', retail: 138_000, wholesale: 192_000 },
  { date: '21 Jul', retail: 116_000, wholesale: 168_000 },
  { date: '25 Jul', retail: 152_000, wholesale: 204_000 },
  { date: '28 Jul', retail: 184_500, wholesale: 221_000 },
];

export const DEMO_SHOPS: ShopPerformance[] = [
  { id: '1', code: 'SHOP1', name: 'Main Store', sales: 14_80_000, profit: 3_92_000, target: 15_00_000, stockValue: 42_00_000 },
  { id: '2', code: 'SHOP2', name: 'Wholesale Depot', sales: 18_20_000, profit: 4_10_000, target: 16_00_000, stockValue: 61_50_000 },
  { id: '3', code: 'SHOP3', name: 'City Centre', sales: 5_40_000, profit: 1_70_000, target: 7_00_000, stockValue: 21_00_000 },
];

export const DEMO_TOP_PRODUCTS: TopProduct[] = [
  { name: 'Banarasi Silk Saree', category: 'Sarees', quantity: 148, revenue: 8_88_000 },
  { name: 'Cotton Kurta Set', category: 'Men Wear', quantity: 312, revenue: 4_68_000 },
  { name: 'Kashmiri Shawl', category: 'Winter Wear', quantity: 96, revenue: 3_84_000 },
  { name: 'Wedding Sherwani', category: 'Men Wear', quantity: 42, revenue: 3_36_000 },
  { name: 'School Uniform Set', category: 'Uniforms', quantity: 480, revenue: 2_88_000 },
  { name: 'Cotton Fabric Roll', category: 'Fabric', quantity: 210, revenue: 2_31_000 },
];

export const DEMO_ALERTS: StockAlert[] = [
  { id: '1', severity: 'CRITICAL', product: 'Banarasi Silk Saree — Red', shop: 'Main Store', currentStock: 2, minStock: 20 },
  { id: '2', severity: 'CRITICAL', product: 'Wedding Sherwani — XL', shop: 'City Centre', currentStock: 0, minStock: 8 },
  { id: '3', severity: 'WARNING', product: 'Kashmiri Shawl — Beige', shop: 'Wholesale Depot', currentStock: 14, minStock: 25 },
  { id: '4', severity: 'WARNING', product: 'Cotton Kurta — M', shop: 'Main Store', currentStock: 18, minStock: 30 },
  { id: '5', severity: 'INFO', product: 'Ladies Stole — Pink', shop: 'City Centre', currentStock: 32, minStock: 35 },
];

export const DEMO_AI_INSIGHTS = [
  {
    id: '1',
    title: 'Wedding season stock gap',
    summary:
      'Sherwani and Groom Set sales are up 34% month on month, but Shop 3 is out of XL. At the current rate you will lose roughly ₹1.2L of sales before the next delivery from Amritsar Ethnic Wear (14-day lead time).',
    impactValue: 120_000,
    confidence: 0.82,
    severity: 'WARNING' as const,
  },
  {
    id: '2',
    title: 'Supplier concentration risk',
    summary:
      '46% of saree purchases go to Banaras Silk House. Their late-delivery rate has risen from 8% to 19% this quarter. Kolkata Handloom Society offers comparable quality at 4% lower cost.',
    impactValue: 85_000,
    confidence: 0.71,
    severity: 'INFO' as const,
  },
  {
    id: '3',
    title: 'Dead stock building',
    summary:
      '₹3.4L of summer cotton stock has not moved in 90 days across all shops. A 20% festive discount would recover about ₹2.7L versus roughly ₹1.9L if held until next summer.',
    impactValue: 340_000,
    confidence: 0.88,
    severity: 'CRITICAL' as const,
  },
];
