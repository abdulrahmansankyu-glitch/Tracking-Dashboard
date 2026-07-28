/**
 * Role-Based Access Control.
 *
 * Permissions are `resource:action` strings. Roles are bundles of permissions, and a
 * user's effective permission set is (role permissions) ∪ (explicit grants) − (explicit
 * denials). Denials win, which is what lets an owner say "Managers can do everything
 * except delete suppliers" without inventing a new role.
 *
 * Scope matters as much as permission: a Manager holds the same permissions as another
 * Manager but only over the shops assigned to them. The API enforces scope separately in
 * the tenant/shop guard — this file only answers "may this action be performed at all".
 */

export const RESOURCES = [
  'dashboard',
  'shop',
  'supplier',
  'product',
  'category',
  'brand',
  'inventory',
  'stock_transfer',
  'stock_adjustment',
  'customer',
  'sale',
  'pos',
  'sales_return',
  'purchase_order',
  'goods_receipt',
  'purchase_bill',
  'purchase_return',
  'payment',
  'receipt',
  'accounting',
  'ledger',
  'journal',
  'gst',
  'expense',
  'employee',
  'attendance',
  'payroll',
  'document',
  'report',
  'ai',
  'notification',
  'user',
  'role',
  'settings',
  'audit_log',
  'backup',
] as const;

export type Resource = (typeof RESOURCES)[number];

export const ACTIONS = [
  'create',
  'read',
  'update',
  'delete',
  'archive',
  'restore',
  'import',
  'export',
  'print',
  'approve',
  'void',
  'manage',
] as const;

export type Action = (typeof ACTIONS)[number];

export type Permission = `${Resource}:${Action}` | '*:*' | `${Resource}:*`;

export const ROLES = [
  'OWNER',
  'ADMIN',
  'MANAGER',
  'ACCOUNTANT',
  'CASHIER',
  'SALES_STAFF',
  'WAREHOUSE_STAFF',
  'AUDITOR',
] as const;

export type RoleName = (typeof ROLES)[number];

/** Every action on a resource. */
const all = (resource: Resource): Permission[] =>
  ACTIONS.map((action) => `${resource}:${action}` as Permission);

/** Read-only plus the export/print pair that every read-only user legitimately needs. */
const readOnly = (resource: Resource): Permission[] => [
  `${resource}:read`,
  `${resource}:export`,
  `${resource}:print`,
];

const crud = (resource: Resource): Permission[] => [
  `${resource}:create`,
  `${resource}:read`,
  `${resource}:update`,
  `${resource}:archive`,
  `${resource}:export`,
  `${resource}:print`,
];

export const ROLE_PERMISSIONS: Readonly<Record<RoleName, readonly Permission[]>> = {
  /** The business owner. Unrestricted, and the only role that can manage roles/backups. */
  OWNER: ['*:*'],

  /** Full operational control; cannot alter the owner's account or destroy audit logs. */
  ADMIN: [
    ...RESOURCES.filter((r) => r !== 'backup').flatMap(all),
    ...readOnly('backup'),
  ],

  /** Runs one or more shops end to end, within their assigned shop scope. */
  MANAGER: [
    ...readOnly('dashboard'),
    ...readOnly('shop'),
    ...crud('supplier'),
    ...crud('product'),
    ...crud('category'),
    ...crud('brand'),
    ...all('inventory'),
    ...all('stock_transfer'),
    ...crud('stock_adjustment'),
    'stock_adjustment:approve',
    ...crud('customer'),
    ...all('sale'),
    ...all('pos'),
    ...crud('sales_return'),
    'sales_return:approve',
    ...crud('purchase_order'),
    'purchase_order:approve',
    ...crud('goods_receipt'),
    ...crud('purchase_bill'),
    ...crud('purchase_return'),
    ...crud('payment'),
    ...crud('receipt'),
    ...readOnly('accounting'),
    ...readOnly('gst'),
    ...crud('expense'),
    'expense:approve',
    ...crud('employee'),
    ...all('attendance'),
    ...readOnly('payroll'),
    ...crud('document'),
    ...readOnly('report'),
    'ai:read',
    'ai:create',
    ...crud('notification'),
    ...readOnly('audit_log'),
  ],

  /** Books, taxes and money. No stock movement, no pricing changes. */
  ACCOUNTANT: [
    ...readOnly('dashboard'),
    ...readOnly('shop'),
    ...readOnly('supplier'),
    ...readOnly('product'),
    ...readOnly('inventory'),
    ...readOnly('customer'),
    ...readOnly('sale'),
    ...readOnly('purchase_order'),
    ...readOnly('goods_receipt'),
    ...crud('purchase_bill'),
    ...all('payment'),
    ...all('receipt'),
    ...all('accounting'),
    ...all('ledger'),
    ...all('journal'),
    ...all('gst'),
    ...all('expense'),
    ...readOnly('payroll'),
    'payroll:approve',
    ...crud('document'),
    ...readOnly('report'),
    'ai:read',
    ...readOnly('audit_log'),
  ],

  /** Billing counter. Sells and takes payment; cannot change prices or void invoices. */
  CASHIER: [
    ...readOnly('dashboard'),
    ...readOnly('product'),
    'inventory:read',
    ...crud('customer'),
    'sale:create',
    'sale:read',
    'sale:print',
    ...all('pos'),
    'sales_return:create',
    'sales_return:read',
    'receipt:create',
    'receipt:read',
    'receipt:print',
    'report:read',
    'ai:read',
  ],

  /** Shop floor. Sells, but settlement and returns go through a cashier or manager. */
  SALES_STAFF: [
    ...readOnly('dashboard'),
    ...readOnly('product'),
    'inventory:read',
    'customer:create',
    'customer:read',
    'customer:update',
    'sale:create',
    'sale:read',
    'sale:print',
    'pos:create',
    'pos:read',
    'report:read',
    'ai:read',
  ],

  /** Moves goods. Sees quantities, never sees money. */
  WAREHOUSE_STAFF: [
    ...readOnly('dashboard'),
    ...readOnly('product'),
    ...all('inventory'),
    ...all('stock_transfer'),
    'stock_adjustment:create',
    'stock_adjustment:read',
    ...crud('goods_receipt'),
    'purchase_order:read',
    'document:create',
    'document:read',
    'report:read',
  ],

  /** External CA or internal auditor: sees everything, changes nothing. */
  AUDITOR: [
    ...RESOURCES.flatMap(readOnly),
    'audit_log:read',
    'audit_log:export',
  ],
};

/** Does `granted` satisfy `required`, honouring `*` wildcards? */
export function permissionMatches(granted: Permission, required: Permission): boolean {
  if (granted === '*:*') return true;
  if (granted === required) return true;
  const [gRes, gAct] = granted.split(':');
  const [rRes, rAct] = required.split(':');
  if (gRes !== rRes) return false;
  return gAct === '*' || gAct === rAct;
}

export function hasPermission(
  grantedPermissions: readonly Permission[],
  required: Permission,
): boolean {
  return grantedPermissions.some((granted) => permissionMatches(granted, required));
}

/**
 * Effective permissions for a user: role bundles, plus explicit grants, minus explicit
 * denials. Denials are applied last and always win.
 */
export function resolveEffectivePermissions(input: {
  roles: readonly RoleName[];
  extraGrants?: readonly Permission[];
  denials?: readonly Permission[];
}): Permission[] {
  const granted = new Set<Permission>();
  for (const role of input.roles) {
    for (const permission of ROLE_PERMISSIONS[role] ?? []) granted.add(permission);
  }
  for (const permission of input.extraGrants ?? []) granted.add(permission);

  if (!input.denials?.length) return [...granted];

  // A denial must also puncture a wildcard, so expand wildcards before subtracting.
  const denials = input.denials;
  const expanded = new Set<Permission>();
  for (const permission of granted) {
    if (permission === '*:*') {
      for (const resource of RESOURCES) for (const action of ACTIONS) {
        expanded.add(`${resource}:${action}` as Permission);
      }
    } else if (permission.endsWith(':*')) {
      const resource = permission.split(':')[0] as Resource;
      for (const action of ACTIONS) expanded.add(`${resource}:${action}` as Permission);
    } else {
      expanded.add(permission);
    }
  }
  return [...expanded].filter(
    (permission) => !denials.some((denial) => permissionMatches(denial, permission)),
  );
}

/** Human-readable role metadata for the settings UI. */
export const ROLE_METADATA: Readonly<
  Record<RoleName, { label: string; description: string; colour: string }>
> = {
  OWNER: { label: 'Owner', description: 'Full control of the business and all shops', colour: '#f59e0b' },
  ADMIN: { label: 'Admin', description: 'Full operational control across all shops', colour: '#8b5cf6' },
  MANAGER: { label: 'Branch Manager', description: 'Runs assigned shops end to end', colour: '#3b82f6' },
  ACCOUNTANT: { label: 'Accountant', description: 'Books, GST filings and payments', colour: '#10b981' },
  CASHIER: { label: 'Cashier', description: 'Billing counter and payment collection', colour: '#06b6d4' },
  SALES_STAFF: { label: 'Sales Staff', description: 'Shop floor selling and customer service', colour: '#ec4899' },
  WAREHOUSE_STAFF: { label: 'Warehouse Staff', description: 'Stock receipt, transfer and counting', colour: '#f97316' },
  AUDITOR: { label: 'Auditor', description: 'Read-only access for audit and review', colour: '#64748b' },
};
