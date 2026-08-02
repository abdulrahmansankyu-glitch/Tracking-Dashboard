/**
 * Seed: the Intoto business as it stands today.
 *
 * Idempotent — every write is an upsert keyed on a natural business key, so running it
 * twice does not duplicate anything and it is safe to re-run after a schema change.
 *
 *   pnpm db:seed
 */

import {
  AccountType,
  PrismaClient,
  RoleName,
  ShopType,
  StockMovementType,
} from '@prisma/client';
import { ROLE_METADATA, ROLE_PERMISSIONS, TEXTILE_HSN_CODES, UNITS_OF_MEASURE } from '@intoto/shared';
import bcrypt from 'bcryptjs';
import { resolve } from 'node:path';

// tsx does not load .env the way the Prisma CLI does, so the seed loads it itself.
// Resolved from cwd (apps/api when run via `pnpm db:seed`) rather than import.meta.url,
// which is undefined once tsx compiles this to CommonJS.
for (const envFile of ['../../.env', '.env']) {
  try {
    process.loadEnvFile(resolve(process.cwd(), envFile));
  } catch {
    // Absent file is fine — the variable may already be set in the environment.
  }
}
if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env at the repository root.');
}

const prisma = new PrismaClient();

const ORG_ID = 'intoto-org-001';
const DEFAULT_PASSWORD = process.env.SEED_PASSWORD ?? 'Intoto@2025';

async function main(): Promise<void> {
  console.log('Seeding Intoto ERP…\n');

  // ---------------------------------------------------------------------------
  // Organization
  // ---------------------------------------------------------------------------
  const organization = await prisma.organization.upsert({
    where: { id: ORG_ID },
    update: {},
    create: {
      id: ORG_ID,
      name: 'Intoto',
      legalName: 'Intoto Textiles',
      gstin: '09AAACI1234F1ZV',
      pan: 'AAACI1234F',
      email: 'contact@intoto.in',
      phone: '9876500000',
      addressLine1: 'Cloth Market, Main Road',
      city: 'Varanasi',
      district: 'Varanasi',
      stateCode: '09',
      pincode: '221001',
      currency: 'INR',
      timezone: 'Asia/Kolkata',
      valuationMethod: 'WEIGHTED_AVERAGE',
    },
  });
  console.log(`  Organization: ${organization.name}`);

  // ---------------------------------------------------------------------------
  // Roles — permissions come from packages/shared so the matrix has one definition
  // ---------------------------------------------------------------------------
  for (const roleName of Object.keys(ROLE_PERMISSIONS) as RoleName[]) {
    const meta = ROLE_METADATA[roleName];
    await prisma.role.upsert({
      where: { name: roleName },
      update: { permissions: [...ROLE_PERMISSIONS[roleName]], label: meta.label },
      create: {
        name: roleName,
        label: meta.label,
        description: meta.description,
        permissions: [...ROLE_PERMISSIONS[roleName]],
        isSystem: true,
      },
    });
  }
  console.log(`  Roles: ${Object.keys(ROLE_PERMISSIONS).length}`);

  // ---------------------------------------------------------------------------
  // Reference data
  // ---------------------------------------------------------------------------
  for (const unit of UNITS_OF_MEASURE) {
    await prisma.unitOfMeasure.upsert({
      where: { code: unit.code },
      update: {},
      create: { code: unit.code, name: unit.name, uqc: unit.uqc },
    });
  }

  // De-duplicate: the shared table lists 5407 and 6211 twice under different categories.
  const seenHsn = new Set<string>();
  for (const hsn of TEXTILE_HSN_CODES) {
    if (seenHsn.has(hsn.code)) continue;
    seenHsn.add(hsn.code);
    await prisma.hsnCode.upsert({
      where: { code: hsn.code },
      update: {},
      create: {
        code: hsn.code,
        description: hsn.description,
        gstRate: hsn.rate,
        thresholdAmount: hsn.thresholdAmount,
        rateAbove: hsn.rateAbove,
        category: hsn.category,
      },
    });
  }
  console.log(`  Units: ${UNITS_OF_MEASURE.length} · HSN codes: ${seenHsn.size}`);

  // ---------------------------------------------------------------------------
  // Shops — the three physical branches
  // ---------------------------------------------------------------------------
  const shopSeed = [
    {
      code: 'SHOP1',
      name: 'Intoto Main Store',
      type: ShopType.BOTH,
      addressLine1: 'Cloth Market, Main Road',
      city: 'Varanasi',
      pincode: '221001',
      monthlyRent: 45000,
      areaSqft: 1800,
      floorWidth: 12,
      floorDepth: 18,
    },
    {
      code: 'SHOP2',
      name: 'Intoto Wholesale Depot',
      type: ShopType.WHOLESALE,
      addressLine1: 'Textile Hub, Sector 4',
      city: 'Varanasi',
      pincode: '221010',
      monthlyRent: 62000,
      areaSqft: 3200,
      floorWidth: 18,
      floorDepth: 24,
    },
    {
      code: 'SHOP3',
      name: 'Intoto City Centre',
      type: ShopType.RETAIL,
      addressLine1: 'City Centre Mall, Ground Floor',
      city: 'Varanasi',
      pincode: '221005',
      monthlyRent: 78000,
      areaSqft: 1200,
      floorWidth: 10,
      floorDepth: 14,
    },
  ];

  const shops = [];
  for (const shop of shopSeed) {
    shops.push(
      await prisma.shop.upsert({
        where: { organizationId_code: { organizationId: ORG_ID, code: shop.code } },
        update: {},
        create: {
          ...shop,
          organizationId: ORG_ID,
          gstin: organization.gstin,
          stateCode: '09',
          phone: '9876500001',
          invoicePrefix: 'INV',
          openingDate: new Date('2019-04-01'),
        },
      }),
    );
  }
  console.log(`  Shops: ${shops.length}`);

  // ---------------------------------------------------------------------------
  // Users
  // ---------------------------------------------------------------------------
  const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, 12);
  const userSeed = [
    { email: 'owner@intoto.in', name: 'Owner', phone: '9876500000', role: RoleName.OWNER, shops: [] },
    { email: 'admin@intoto.in', name: 'System Admin', phone: '9876500002', role: RoleName.ADMIN, shops: [] },
    { email: 'manager1@intoto.in', name: 'Main Store Manager', phone: '9876500011', role: RoleName.MANAGER, shops: ['SHOP1'] },
    { email: 'manager2@intoto.in', name: 'Depot Manager', phone: '9876500012', role: RoleName.MANAGER, shops: ['SHOP2'] },
    { email: 'accountant@intoto.in', name: 'Accountant', phone: '9876500003', role: RoleName.ACCOUNTANT, shops: [] },
    { email: 'cashier1@intoto.in', name: 'Counter Cashier', phone: '9876500021', role: RoleName.CASHIER, shops: ['SHOP1'] },
    { email: 'sales1@intoto.in', name: 'Sales Assistant', phone: '9876500031', role: RoleName.SALES_STAFF, shops: ['SHOP3'] },
    { email: 'warehouse@intoto.in', name: 'Warehouse Staff', phone: '9876500041', role: RoleName.WAREHOUSE_STAFF, shops: ['SHOP2'] },
  ];

  for (const seed of userSeed) {
    const user = await prisma.user.upsert({
      where: { organizationId_email: { organizationId: ORG_ID, email: seed.email } },
      update: {},
      create: {
        organizationId: ORG_ID,
        name: seed.name,
        email: seed.email,
        phone: seed.phone,
        passwordHash,
        status: 'ACTIVE',
      },
    });

    const role = await prisma.role.findUnique({ where: { name: seed.role } });
    if (role) {
      await prisma.userRole.upsert({
        where: { userId_roleId: { userId: user.id, roleId: role.id } },
        update: {},
        create: { userId: user.id, roleId: role.id },
      });
    }

    // An empty shop list means org-wide access, so nothing is written for those users.
    for (const shopCode of seed.shops) {
      const shop = shops.find((s) => s.code === shopCode);
      if (!shop) continue;
      await prisma.userShop.upsert({
        where: { userId_shopId: { userId: user.id, shopId: shop.id } },
        update: {},
        create: { userId: user.id, shopId: shop.id, isPrimary: true },
      });
    }
  }
  console.log(`  Users: ${userSeed.length}`);

  // ---------------------------------------------------------------------------
  // Chart of accounts — Indian retail/wholesale
  // ---------------------------------------------------------------------------
  const accountSeed: Array<{ code: string; name: string; type: AccountType; system?: boolean; cash?: boolean; bank?: boolean }> = [
    // Assets
    { code: '1000', name: 'Cash in Hand', type: AccountType.ASSET, system: true, cash: true },
    { code: '1010', name: 'Bank Accounts', type: AccountType.ASSET, system: true, bank: true },
    { code: '1100', name: 'Accounts Receivable', type: AccountType.ASSET, system: true },
    { code: '1200', name: 'Inventory', type: AccountType.ASSET, system: true },
    { code: '1300', name: 'Input CGST', type: AccountType.ASSET, system: true },
    { code: '1310', name: 'Input SGST', type: AccountType.ASSET, system: true },
    { code: '1320', name: 'Input IGST', type: AccountType.ASSET, system: true },
    { code: '1400', name: 'Fixed Assets', type: AccountType.ASSET },
    { code: '1410', name: 'Accumulated Depreciation', type: AccountType.ASSET },
    { code: '1500', name: 'Advances to Staff', type: AccountType.ASSET },
    // Liabilities
    { code: '2000', name: 'Accounts Payable', type: AccountType.LIABILITY, system: true },
    { code: '2100', name: 'Output CGST', type: AccountType.LIABILITY, system: true },
    { code: '2110', name: 'Output SGST', type: AccountType.LIABILITY, system: true },
    { code: '2120', name: 'Output IGST', type: AccountType.LIABILITY, system: true },
    { code: '2130', name: 'GST Payable', type: AccountType.LIABILITY, system: true },
    { code: '2200', name: 'Salary Payable', type: AccountType.LIABILITY },
    { code: '2300', name: 'Customer Advances', type: AccountType.LIABILITY },
    // Equity
    { code: '3000', name: "Owner's Capital", type: AccountType.EQUITY },
    { code: '3100', name: 'Retained Earnings', type: AccountType.EQUITY, system: true },
    { code: '3200', name: 'Drawings', type: AccountType.EQUITY },
    // Income
    { code: '4000', name: 'Sales — Retail', type: AccountType.INCOME, system: true },
    { code: '4010', name: 'Sales — Wholesale', type: AccountType.INCOME, system: true },
    { code: '4100', name: 'Sales Returns', type: AccountType.INCOME, system: true },
    { code: '4200', name: 'Discount Allowed', type: AccountType.INCOME },
    { code: '4900', name: 'Other Income', type: AccountType.INCOME },
    { code: '4910', name: 'Round Off', type: AccountType.INCOME, system: true },
    // Expenses
    { code: '5000', name: 'Cost of Goods Sold', type: AccountType.EXPENSE, system: true },
    { code: '5100', name: 'Purchase Returns', type: AccountType.EXPENSE, system: true },
    { code: '5200', name: 'Stock Write-off', type: AccountType.EXPENSE, system: true },
    { code: '6000', name: 'Rent', type: AccountType.EXPENSE },
    { code: '6010', name: 'Electricity', type: AccountType.EXPENSE },
    { code: '6020', name: 'Water', type: AccountType.EXPENSE },
    { code: '6030', name: 'Internet & Telephone', type: AccountType.EXPENSE },
    { code: '6040', name: 'Insurance', type: AccountType.EXPENSE },
    { code: '6100', name: 'Salaries & Wages', type: AccountType.EXPENSE },
    { code: '6110', name: 'Staff Commission', type: AccountType.EXPENSE },
    { code: '6200', name: 'Transport & Freight', type: AccountType.EXPENSE },
    { code: '6210', name: 'Fuel', type: AccountType.EXPENSE },
    { code: '6220', name: 'Packing Material', type: AccountType.EXPENSE },
    { code: '6230', name: 'Courier', type: AccountType.EXPENSE },
    { code: '6300', name: 'Repairs & Maintenance', type: AccountType.EXPENSE },
    { code: '6400', name: 'Marketing & Advertising', type: AccountType.EXPENSE },
    { code: '6500', name: 'Office Expenses', type: AccountType.EXPENSE },
    { code: '6600', name: 'Depreciation', type: AccountType.EXPENSE },
    { code: '6900', name: 'Miscellaneous', type: AccountType.EXPENSE },
  ];

  for (const account of accountSeed) {
    await prisma.account.upsert({
      where: { organizationId_code: { organizationId: ORG_ID, code: account.code } },
      update: {},
      create: {
        organizationId: ORG_ID,
        code: account.code,
        name: account.name,
        type: account.type,
        isSystem: account.system ?? false,
        isCashAccount: account.cash ?? false,
        isBankAccount: account.bank ?? false,
      },
    });
  }
  console.log(`  Chart of accounts: ${accountSeed.length}`);

  // ---------------------------------------------------------------------------
  // Expense categories
  // ---------------------------------------------------------------------------
  const expenseCategories = [
    { name: 'Rent', code: '6000', recurring: true },
    { name: 'Electricity', code: '6010', recurring: true },
    { name: 'Water', code: '6020', recurring: true },
    { name: 'Internet', code: '6030', recurring: true },
    { name: 'Insurance', code: '6040', recurring: true },
    { name: 'Salary', code: '6100', recurring: true },
    { name: 'Transport', code: '6200' },
    { name: 'Fuel', code: '6210' },
    { name: 'Packing', code: '6220' },
    { name: 'Courier', code: '6230' },
    { name: 'Maintenance', code: '6300' },
    { name: 'Marketing', code: '6400' },
    { name: 'Office Expense', code: '6500' },
    { name: 'Repair', code: '6300' },
    { name: 'Miscellaneous', code: '6900' },
  ];

  for (const category of expenseCategories) {
    const account = await prisma.account.findUnique({
      where: { organizationId_code: { organizationId: ORG_ID, code: category.code } },
    });
    const slug = category.name.toLowerCase().replace(/\s+/g, '-');
    await prisma.expenseCategory.upsert({
      where: { organizationId_slug: { organizationId: ORG_ID, slug } },
      update: {},
      create: {
        organizationId: ORG_ID,
        name: category.name,
        slug,
        accountId: account?.id,
        isRecurringByNature: category.recurring ?? false,
      },
    });
  }
  console.log(`  Expense categories: ${expenseCategories.length}`);

  // ---------------------------------------------------------------------------
  // Product categories — the Intoto catalogue
  // ---------------------------------------------------------------------------
  const categoryTree: Array<{ name: string; hsn: string; gst: number; children: string[] }> = [
    { name: 'Fabric', hsn: '5208', gst: 5, children: ['Cotton Rolls', 'Silk Rolls', 'Synthetic Rolls', 'Wool Fabric'] },
    { name: 'Sarees', hsn: '6211', gst: 5, children: ['Banarasi Saree', 'Cotton Saree', 'Silk Saree', 'Wedding Saree'] },
    { name: 'Men Wear', hsn: '6203', gst: 5, children: ['Sherwani', 'Groom Sets', 'Kurta', 'Pajama', 'Shirt', 'Pant'] },
    { name: 'Ladies Wear', hsn: '6204', gst: 5, children: ['Salwar Suit', 'Lehenga', 'Kurti', 'Dress Material'] },
    { name: 'Children Wear', hsn: '6209', gst: 5, children: ['Boys Wear', 'Girls Wear', 'Infant Wear'] },
    { name: 'Winter Wear', hsn: '6301', gst: 5, children: ['Blankets', 'Kashmiri Shawls', 'Ladies Stoles', 'Winter Stoles'] },
    { name: 'Uniforms', hsn: '6203', gst: 5, children: ['School Uniform', 'College Uniform'] },
    { name: 'Accessories', hsn: '6217', gst: 5, children: ['Belts', 'Ties', 'Imitation Jewellery'] },
  ];

  let categoryCount = 0;
  for (const parent of categoryTree) {
    const parentSlug = parent.name.toLowerCase().replace(/\s+/g, '-');
    const parentRecord = await prisma.category.upsert({
      where: { organizationId_slug: { organizationId: ORG_ID, slug: parentSlug } },
      update: {},
      create: {
        organizationId: ORG_ID,
        name: parent.name,
        slug: parentSlug,
        defaultHsnCode: parent.hsn,
        defaultGstRate: parent.gst,
      },
    });
    categoryCount += 1;

    for (const child of parent.children) {
      const childSlug = child.toLowerCase().replace(/\s+/g, '-');
      await prisma.category.upsert({
        where: { organizationId_slug: { organizationId: ORG_ID, slug: childSlug } },
        update: {},
        create: {
          organizationId: ORG_ID,
          parentId: parentRecord.id,
          name: child,
          slug: childSlug,
          defaultHsnCode: parent.hsn,
          defaultGstRate: parent.gst,
        },
      });
      categoryCount += 1;
    }
  }
  console.log(`  Categories: ${categoryCount}`);

  // ---------------------------------------------------------------------------
  // Suppliers — the ~20 the business buys from
  // ---------------------------------------------------------------------------
  const supplierSeed = [
    { name: 'Banaras Silk House', owner: 'Ramesh Gupta', city: 'Varanasi', state: '09', category: 'Sarees', credit: 30 },
    { name: 'Surat Synthetics Pvt Ltd', owner: 'Jayesh Patel', city: 'Surat', state: '24', category: 'Fabric', credit: 45 },
    { name: 'Ludhiana Woollen Mills', owner: 'Harpreet Singh', city: 'Ludhiana', state: '03', category: 'Winter Wear', credit: 30 },
    { name: 'Kashmir Shawl Emporium', owner: 'Bilal Ahmed', city: 'Srinagar', state: '01', category: 'Winter Wear', credit: 21 },
    { name: 'Tirupur Knitwear Exports', owner: 'Murugan S', city: 'Tirupur', state: '33', category: 'Men Wear', credit: 30 },
    { name: 'Ahmedabad Cotton Traders', owner: 'Nitin Shah', city: 'Ahmedabad', state: '24', category: 'Fabric', credit: 60 },
    { name: 'Jaipur Block Prints', owner: 'Vikram Rathore', city: 'Jaipur', state: '08', category: 'Ladies Wear', credit: 30 },
    { name: 'Delhi Fashion Wholesale', owner: 'Anil Khanna', city: 'Delhi', state: '07', category: 'Ladies Wear', credit: 15 },
    { name: 'Kolkata Handloom Society', owner: 'Subrata Das', city: 'Kolkata', state: '19', category: 'Sarees', credit: 30 },
    { name: 'Bhilwara Suitings', owner: 'Mahesh Jain', city: 'Bhilwara', state: '08', category: 'Fabric', credit: 45 },
    { name: 'Panipat Blanket Works', owner: 'Rajesh Kumar', city: 'Panipat', state: '06', category: 'Winter Wear', credit: 30 },
    { name: 'Mumbai Uniform Suppliers', owner: 'Deepak Joshi', city: 'Mumbai', state: '27', category: 'Uniforms', credit: 30 },
    { name: 'Chennai Silk Traders', owner: 'Karthik R', city: 'Chennai', state: '33', category: 'Sarees', credit: 30 },
    { name: 'Erode Textile Park', owner: 'Selvam K', city: 'Erode', state: '33', category: 'Fabric', credit: 45 },
    { name: 'Lucknow Chikankari House', owner: 'Imran Siddiqui', city: 'Lucknow', state: '09', category: 'Ladies Wear', credit: 21 },
    { name: 'Indore Kids Wear', owner: 'Sanjay Verma', city: 'Indore', state: '23', category: 'Children Wear', credit: 30 },
    { name: 'Amritsar Ethnic Wear', owner: 'Gurdeep Kaur', city: 'Amritsar', state: '03', category: 'Men Wear', credit: 30 },
    { name: 'Bengaluru Accessories Hub', owner: 'Prakash N', city: 'Bengaluru', state: '29', category: 'Accessories', credit: 15 },
    { name: 'Kanpur Garment Co', owner: 'Alok Tripathi', city: 'Kanpur', state: '09', category: 'Men Wear', credit: 30 },
    { name: 'Bhagalpur Silk Weavers', owner: 'Manoj Mishra', city: 'Bhagalpur', state: '10', category: 'Sarees', credit: 45 },
  ];

  for (const [index, supplier] of supplierSeed.entries()) {
    const code = `SUP${String(index + 1).padStart(3, '0')}`;
    await prisma.supplier.upsert({
      where: { organizationId_code: { organizationId: ORG_ID, code } },
      update: {},
      create: {
        organizationId: ORG_ID,
        code,
        companyName: supplier.name,
        ownerName: supplier.owner,
        phone: `98765${String(10000 + index).padStart(5, '0')}`,
        email: `${supplier.name.toLowerCase().replace(/[^a-z]/g, '').slice(0, 16)}@example.in`,
        city: supplier.city,
        stateCode: supplier.state,
        country: 'IN',
        category: supplier.category,
        creditPeriodDays: supplier.credit,
      },
    });
  }
  console.log(`  Suppliers: ${supplierSeed.length}`);

  // ---------------------------------------------------------------------------
  // Products — a representative slice of the Intoto catalogue
  // ---------------------------------------------------------------------------
  const productSeed: Array<{
    sku: string; name: string; category: string; supplier: string; hsn: string;
    gst: number; cost: number; price: number; mrp: number; unit: string;
    colour?: string; size?: string; fabric?: string; season?: string; min: number;
  }> = [
    // Sarees — HSN 6211, value-dependent slab
    { sku: 'SAR-BAN-001', name: 'Banarasi Silk Saree — Zari Border', category: 'banarasi-saree', supplier: 'SUP001', hsn: '6211', gst: 12, cost: 3200, price: 5400, mrp: 6000, unit: 'PCS', colour: 'Maroon', fabric: 'Silk', season: 'WEDDING', min: 20 },
    { sku: 'SAR-BAN-002', name: 'Banarasi Silk Saree — Katan', category: 'banarasi-saree', supplier: 'SUP001', hsn: '6211', gst: 12, cost: 4100, price: 6800, mrp: 7500, unit: 'PCS', colour: 'Red', fabric: 'Silk', season: 'WEDDING', min: 15 },
    { sku: 'SAR-COT-001', name: 'Cotton Saree — Handloom', category: 'cotton-saree', supplier: 'SUP009', hsn: '6211', gst: 5, cost: 420, price: 750, mrp: 900, unit: 'PCS', colour: 'Blue', fabric: 'Cotton', season: 'SUMMER', min: 40 },
    { sku: 'SAR-COT-002', name: 'Cotton Saree — Printed', category: 'cotton-saree', supplier: 'SUP009', hsn: '6211', gst: 5, cost: 380, price: 680, mrp: 800, unit: 'PCS', colour: 'Green', fabric: 'Cotton', season: 'SUMMER', min: 40 },
    { sku: 'SAR-WED-001', name: 'Wedding Saree — Heavy Work', category: 'wedding-saree', supplier: 'SUP013', hsn: '6211', gst: 12, cost: 6500, price: 11500, mrp: 13000, unit: 'PCS', colour: 'Pink', fabric: 'Silk', season: 'WEDDING', min: 10 },
    { sku: 'SAR-SLK-001', name: 'Bhagalpur Silk Saree', category: 'silk-saree', supplier: 'SUP020', hsn: '6211', gst: 12, cost: 2200, price: 3900, mrp: 4400, unit: 'PCS', colour: 'Golden', fabric: 'Silk', season: 'FESTIVE', min: 20 },

    // Men wear — HSN 6203 / 6205 / 6207
    { sku: 'MEN-SHR-001', name: 'Sherwani — Embroidered', category: 'sherwani', supplier: 'SUP017', hsn: '6203', gst: 12, cost: 5800, price: 9800, mrp: 11000, unit: 'PCS', colour: 'Cream', size: 'L', fabric: 'Silk Blend', season: 'WEDDING', min: 8 },
    { sku: 'MEN-SHR-002', name: 'Sherwani — Classic', category: 'sherwani', supplier: 'SUP017', hsn: '6203', gst: 12, cost: 4200, price: 7200, mrp: 8000, unit: 'PCS', colour: 'Maroon', size: 'XL', fabric: 'Brocade', season: 'WEDDING', min: 8 },
    { sku: 'MEN-GRM-001', name: 'Groom Set — Sherwani with Dupatta', category: 'groom-sets', supplier: 'SUP017', hsn: '6203', gst: 12, cost: 9500, price: 16500, mrp: 18500, unit: 'SET', colour: 'Ivory', size: 'L', season: 'WEDDING', min: 5 },
    { sku: 'MEN-KUR-001', name: 'Cotton Kurta — Regular Fit', category: 'kurta', supplier: 'SUP019', hsn: '6207', gst: 5, cost: 340, price: 620, mrp: 750, unit: 'PCS', colour: 'White', size: 'M', fabric: 'Cotton', min: 60 },
    { sku: 'MEN-KUR-002', name: 'Silk Kurta — Festive', category: 'kurta', supplier: 'SUP019', hsn: '6207', gst: 12, cost: 780, price: 1350, mrp: 1600, unit: 'PCS', colour: 'Gold', size: 'L', fabric: 'Silk', season: 'FESTIVE', min: 30 },
    { sku: 'MEN-PAJ-001', name: 'Cotton Pajama', category: 'pajama', supplier: 'SUP019', hsn: '6207', gst: 5, cost: 180, price: 340, mrp: 420, unit: 'PCS', colour: 'White', size: 'M', fabric: 'Cotton', min: 60 },
    { sku: 'MEN-SHT-001', name: 'Formal Shirt — Cotton', category: 'shirt', supplier: 'SUP005', hsn: '6205', gst: 5, cost: 420, price: 780, mrp: 950, unit: 'PCS', colour: 'Sky Blue', size: 'M', fabric: 'Cotton', min: 50 },
    { sku: 'MEN-PNT-001', name: 'Formal Trousers', category: 'pant', supplier: 'SUP010', hsn: '6203', gst: 5, cost: 560, price: 980, mrp: 1200, unit: 'PCS', colour: 'Charcoal', size: '34', fabric: 'Poly Viscose', min: 40 },

    // Ladies wear
    { sku: 'LAD-SLW-001', name: 'Salwar Suit — Unstitched', category: 'salwar-suit', supplier: 'SUP007', hsn: '6204', gst: 5, cost: 480, price: 890, mrp: 1100, unit: 'SET', colour: 'Peach', fabric: 'Cotton', min: 40 },
    { sku: 'LAD-LEH-001', name: 'Lehenga — Bridal', category: 'lehenga', supplier: 'SUP008', hsn: '6204', gst: 12, cost: 12000, price: 21000, mrp: 24000, unit: 'SET', colour: 'Red', size: 'M', season: 'WEDDING', min: 4 },
    { sku: 'LAD-KRT-001', name: 'Chikankari Kurti', category: 'kurti', supplier: 'SUP015', hsn: '6206', gst: 5, cost: 390, price: 720, mrp: 890, unit: 'PCS', colour: 'White', size: 'M', fabric: 'Cotton', min: 45 },
    { sku: 'LAD-DRS-001', name: 'Dress Material — Printed', category: 'dress-material', supplier: 'SUP007', hsn: '6204', gst: 5, cost: 310, price: 560, mrp: 700, unit: 'SET', colour: 'Yellow', fabric: 'Cotton', min: 50 },

    // Winter wear — HSN 6301 / 6214
    { sku: 'WIN-BLK-001', name: 'Woollen Blanket — Double', category: 'blankets', supplier: 'SUP011', hsn: '6301', gst: 12, cost: 780, price: 1350, mrp: 1600, unit: 'PCS', colour: 'Grey', fabric: 'Wool', season: 'WINTER', min: 30 },
    { sku: 'WIN-SHW-001', name: 'Kashmiri Shawl — Pashmina', category: 'kashmiri-shawls', supplier: 'SUP004', hsn: '6214', gst: 12, cost: 2400, price: 4200, mrp: 4800, unit: 'PCS', colour: 'Beige', fabric: 'Pashmina', season: 'WINTER', min: 25 },
    { sku: 'WIN-STL-001', name: 'Ladies Stole — Woollen', category: 'ladies-stoles', supplier: 'SUP003', hsn: '6214', gst: 5, cost: 260, price: 480, mrp: 600, unit: 'PCS', colour: 'Pink', fabric: 'Wool', season: 'WINTER', min: 35 },
    { sku: 'WIN-STL-002', name: 'Winter Stole — Printed', category: 'winter-stoles', supplier: 'SUP003', hsn: '6214', gst: 5, cost: 220, price: 420, mrp: 520, unit: 'PCS', colour: 'Navy', fabric: 'Acrylic', season: 'WINTER', min: 35 },

    // Fabric rolls — sold by the metre, flat 5%
    { sku: 'FAB-COT-001', name: 'Cotton Fabric Roll — 44 inch', category: 'cotton-rolls', supplier: 'SUP006', hsn: '5208', gst: 5, cost: 110, price: 185, mrp: 220, unit: 'MTR', colour: 'White', fabric: 'Cotton', min: 200 },
    { sku: 'FAB-SLK-001', name: 'Silk Fabric Roll — 44 inch', category: 'silk-rolls', supplier: 'SUP001', hsn: '5007', gst: 5, cost: 340, price: 560, mrp: 650, unit: 'MTR', colour: 'Gold', fabric: 'Silk', min: 100 },
    { sku: 'FAB-SYN-001', name: 'Synthetic Fabric Roll', category: 'synthetic-rolls', supplier: 'SUP002', hsn: '5407', gst: 5, cost: 78, price: 140, mrp: 175, unit: 'MTR', colour: 'Assorted', fabric: 'Polyester', min: 250 },

    // Uniforms & children
    { sku: 'UNI-SCH-001', name: 'School Uniform Set — Boys', category: 'school-uniform', supplier: 'SUP012', hsn: '6203', gst: 5, cost: 340, price: 600, mrp: 720, unit: 'SET', colour: 'Navy', size: '28', min: 80 },
    { sku: 'UNI-COL-001', name: 'College Uniform Set', category: 'college-uniform', supplier: 'SUP012', hsn: '6203', gst: 5, cost: 460, price: 820, mrp: 980, unit: 'SET', colour: 'Grey', size: '32', min: 50 },
    { sku: 'CHD-BOY-001', name: 'Boys Ethnic Kurta Set', category: 'boys-wear', supplier: 'SUP016', hsn: '6209', gst: 5, cost: 290, price: 540, mrp: 660, unit: 'SET', colour: 'Blue', size: '6-7Y', season: 'FESTIVE', min: 40 },
    { sku: 'CHD-GRL-001', name: 'Girls Party Frock', category: 'girls-wear', supplier: 'SUP016', hsn: '6209', gst: 5, cost: 340, price: 620, mrp: 760, unit: 'PCS', colour: 'Pink', size: '5-6Y', season: 'FESTIVE', min: 40 },

    // Accessories
    { sku: 'ACC-BLT-001', name: 'Leather Belt — Formal', category: 'belts', supplier: 'SUP018', hsn: '4202', gst: 18, cost: 180, price: 350, mrp: 450, unit: 'PCS', colour: 'Black', min: 30 },
    { sku: 'ACC-TIE-001', name: 'Silk Tie', category: 'ties', supplier: 'SUP018', hsn: '6217', gst: 5, cost: 120, price: 250, mrp: 320, unit: 'PCS', colour: 'Maroon', min: 25 },
  ];

  let productCount = 0;
  for (const item of productSeed) {
    const category = await prisma.category.findUnique({
      where: { organizationId_slug: { organizationId: ORG_ID, slug: item.category } },
    });
    const supplier = await prisma.supplier.findUnique({
      where: { organizationId_code: { organizationId: ORG_ID, code: item.supplier } },
    });
    const unit = await prisma.unitOfMeasure.findUnique({ where: { code: item.unit } });
    if (!category) {
      console.warn(`  ! category "${item.category}" not found for ${item.sku}`);
      continue;
    }

    await prisma.product.upsert({
      where: { organizationId_sku: { organizationId: ORG_ID, sku: item.sku } },
      update: {},
      create: {
        organizationId: ORG_ID,
        sku: item.sku,
        // A scannable EAN-13-shaped code so the POS barcode path is exercisable.
        barcode: `890${String(2000000 + productCount).padStart(10, '0')}`,
        name: item.name,
        categoryId: category.id,
        supplierId: supplier?.id,
        unitId: unit?.id,
        hsnCode: item.hsn,
        gstRate: item.gst,
        colour: item.colour,
        size: item.size,
        fabric: item.fabric,
        season: (item.season ?? 'ALL_SEASON') as never,
        purchaseCost: item.cost,
        sellingPrice: item.price,
        mrp: item.mrp,
        // Retail prices in India are quoted inclusive of GST.
        priceIncludesTax: true,
        minStock: item.min,
        isActive: true,
      } as never,
    });
    productCount += 1;
  }
  console.log(`  Products: ${productCount}`);

  // ---------------------------------------------------------------------------
  // Opening stock
  //
  // Without this the catalogue exists but every shelf is empty: the billing counter has
  // nothing to sell and the dashboard reads zero everywhere.
  //
  // Each balance is written together with the OPENING movement that explains it. The
  // movement ledger is the append-only truth and StockItem is its roll-up, so a balance
  // with no movement behind it would leave valuation and stock history disagreeing from
  // the first day.
  // ---------------------------------------------------------------------------
  const seededProducts = await prisma.product.findMany({
    where: { organizationId: ORG_ID },
    select: { id: true, purchaseCost: true, minStock: true },
    orderBy: { sku: 'asc' },
  });

  // Fixed multipliers rather than random numbers: re-seeding a fresh database then
  // produces the same figures, so a report or screenshot stays reproducible. The depot
  // carries the most, the mall counter the least.
  const stockFactorByShop = [1.8, 3.2, 0.7];

  let stockRows = 0;
  for (const [shopIndex, shop] of shops.entries()) {
    const factor = stockFactorByShop[shopIndex] ?? 1;

    for (const [productIndex, product] of seededProducts.entries()) {
      // Idempotent: a re-run must not stack a second opening balance on the first.
      const existing = await prisma.stockItem.findUnique({
        where: {
          shopId_productId_variantId: { shopId: shop.id, productId: product.id, variantId: '' },
        },
        select: { id: true },
      });
      if (existing) continue;

      // Every seventh product is left deliberately short, so the low-stock report opens
      // with real cases to act on instead of being uniformly green.
      const short = productIndex % 7 === 3;
      const quantity = Math.max(
        0,
        Math.round(Number(product.minStock ?? 0) * factor * (short ? 0.4 : 1)),
      );
      if (quantity === 0) continue;

      const unitCost = Number(product.purchaseCost ?? 0);
      const totalCost = Number((unitCost * quantity).toFixed(4));

      await prisma.$transaction([
        prisma.stockItem.create({
          data: {
            shopId: shop.id,
            productId: product.id,
            variantId: '',
            quantity,
            avgCost: unitCost,
            stockValue: totalCost,
            lastMovementAt: new Date(),
          },
        }),
        prisma.stockMovement.create({
          data: {
            shopId: shop.id,
            productId: product.id,
            type: StockMovementType.OPENING,
            quantity,
            signedQuantity: quantity,
            unitCost,
            totalCost,
            balanceAfter: quantity,
            referenceType: 'SEED',
            notes: 'Opening stock',
          },
        }),
      ]);
      stockRows += 1;
    }
  }
  console.log(`  Opening stock: ${stockRows} shop/product balances`);

  console.log('\nSeed complete.');
  console.log(`  Sign in: owner@intoto.in / ${DEFAULT_PASSWORD}`);
  console.log('  Change this password immediately in any real deployment.\n');
}

main()
  .catch((error: unknown) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
