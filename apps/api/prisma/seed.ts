/**
 * Seed: the Intoto business as it stands today.
 *
 * Idempotent — every write is an upsert keyed on a natural business key, so running it
 * twice does not duplicate anything and it is safe to re-run after a schema change.
 *
 *   pnpm db:seed
 */

import { AccountType, PrismaClient, RoleName, ShopType } from '@prisma/client';
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
