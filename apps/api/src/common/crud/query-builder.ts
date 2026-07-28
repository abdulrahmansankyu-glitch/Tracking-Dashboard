import { BadRequestException } from '@nestjs/common';
import type { FilterCondition, FilterOperator, QueryParams } from '@intoto/shared';

/**
 * Translates the generic list-query contract into a Prisma `where`.
 *
 * Every field name is validated against an allow-list supplied by the resource
 * descriptor. Without that, a caller could filter or sort on `passwordHash` and use the
 * result ordering as an oracle to extract it — a real, well-documented attack on generic
 * query endpoints, not a theoretical one.
 */

export interface QueryBuilderOptions {
  /** Fields matched by the free-text `search` parameter */
  searchFields: string[];
  /** Fields permitted in `filters` */
  filterableFields: string[];
  /** Fields permitted in `sortBy` */
  sortableFields: string[];
  /** Date field that `dateFrom` / `dateTo` apply to */
  dateField?: string;
  /** Default ordering when the caller does not specify one */
  defaultSort?: { field: string; direction: 'asc' | 'desc' };
  /** Model supports soft delete (`deletedAt`) */
  softDelete?: boolean;
  /** Model supports archiving (`archivedAt`) */
  archivable?: boolean;
}

const MAX_PAGE_SIZE = 500;

type PrismaWhere = Record<string, unknown>;

/** Build a nested where for a dotted path: "supplier.companyName" → { supplier: { companyName: … } } */
function nest(path: string, leaf: unknown): PrismaWhere {
  const segments = path.split('.');
  return segments.reduceRight<unknown>((acc, segment, index) => {
    return index === segments.length - 1 ? { [segment]: leaf } : { [segment]: acc };
  }, leaf) as PrismaWhere;
}

function buildCondition(operator: FilterOperator, value: unknown): unknown {
  switch (operator) {
    case 'eq':
      return value;
    case 'ne':
      return { not: value };
    case 'gt':
      return { gt: value };
    case 'gte':
      return { gte: value };
    case 'lt':
      return { lt: value };
    case 'lte':
      return { lte: value };
    case 'contains':
      return { contains: String(value), mode: 'insensitive' };
    case 'startsWith':
      return { startsWith: String(value), mode: 'insensitive' };
    case 'endsWith':
      return { endsWith: String(value), mode: 'insensitive' };
    case 'in':
      return { in: Array.isArray(value) ? value : [value] };
    case 'notIn':
      return { notIn: Array.isArray(value) ? value : [value] };
    case 'between': {
      if (!Array.isArray(value) || value.length !== 2) {
        throw new BadRequestException('"between" needs exactly two values');
      }
      return { gte: value[0], lte: value[1] };
    }
    case 'isNull':
      return null;
    case 'isNotNull':
      return { not: null };
    default:
      throw new BadRequestException(`Unsupported filter operator: ${operator as string}`);
  }
}

export interface BuiltQuery {
  where: PrismaWhere;
  orderBy: Record<string, unknown>;
  skip: number;
  take: number;
  page: number;
  pageSize: number;
}

export function buildQuery(
  params: QueryParams,
  options: QueryBuilderOptions,
  baseWhere: PrismaWhere = {},
): BuiltQuery {
  const and: PrismaWhere[] = [baseWhere];

  // --- Visibility: soft delete + archive ---
  if (options.softDelete !== false) {
    and.push({ deletedAt: null });
  }
  if (options.archivable !== false) {
    if (params.onlyArchived) {
      and.push({ archivedAt: { not: null } });
    } else if (!params.includeArchived) {
      and.push({ archivedAt: null });
    }
  }

  // --- Free-text search across the declared fields ---
  const search = params.search?.trim();
  if (search && options.searchFields.length > 0) {
    and.push({
      OR: options.searchFields.map((field) =>
        nest(field, { contains: search, mode: 'insensitive' }),
      ),
    });
  }

  // --- Structured filters ---
  for (const filter of params.filters ?? []) {
    assertAllowed(filter, options.filterableFields);
    and.push(nest(filter.field, buildCondition(filter.operator, filter.value)));
  }

  // --- Date range ---
  if (options.dateField && (params.dateFrom || params.dateTo)) {
    const range: Record<string, Date> = {};
    if (params.dateFrom) range.gte = new Date(params.dateFrom);
    if (params.dateTo) range.lte = new Date(params.dateTo);
    and.push(nest(options.dateField, range));
  }

  // --- Sorting ---
  const sortField = params.sortBy ?? options.defaultSort?.field ?? 'createdAt';
  if (params.sortBy && !options.sortableFields.includes(params.sortBy)) {
    throw new BadRequestException(
      `Cannot sort by "${params.sortBy}". Sortable fields: ${options.sortableFields.join(', ')}`,
    );
  }
  const direction = params.sortDir ?? options.defaultSort?.direction ?? 'desc';

  // --- Pagination ---
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, params.pageSize ?? 25));

  return {
    where: and.length === 1 ? (and[0] as PrismaWhere) : { AND: and },
    orderBy: nest(sortField, direction),
    skip: (page - 1) * pageSize,
    take: pageSize,
    page,
    pageSize,
  };
}

function assertAllowed(filter: FilterCondition, allowed: string[]): void {
  if (!allowed.includes(filter.field)) {
    throw new BadRequestException(
      `Cannot filter by "${filter.field}". Filterable fields: ${allowed.join(', ')}`,
    );
  }
}

export function pageMeta(total: number, page: number, pageSize: number) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return {
    page,
    pageSize,
    total,
    totalPages,
    hasNext: page < totalPages,
    hasPrevious: page > 1,
  };
}
