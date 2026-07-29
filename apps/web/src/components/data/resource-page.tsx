'use client';

import { AnimatePresence, motion } from 'framer-motion';
import {
  Archive, ArchiveRestore, ChevronDown, ChevronLeft, ChevronRight, ChevronUp,
  Download, FileSpreadsheet, FileText, History, Loader2, MoreVertical, Plus,
  Printer, Search, Upload, X,
} from 'lucide-react';
import { useState } from 'react';
import type { Permission } from '@intoto/shared';

import { Button } from '@/components/ui/button';
import { GlassCard } from '@/components/ui/glass-card';
import { Input } from '@/components/ui/input';
import {
  useResourceExport, useResourceHistory, useResourceMutations, useResourceQuery,
} from '@/hooks/use-resource';
import { cn, formatDateTime } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth-store';

export interface ResourceColumn {
  key: string;
  header: string;
  sortable?: boolean;
  align?: 'left' | 'right';
  /** Hidden below the lg breakpoint — keeps the table readable on a tablet */
  hideOnMobile?: boolean;
  render?: (row: Record<string, unknown>) => React.ReactNode;
}

export interface ResourcePageProps {
  /** API path segment, e.g. 'suppliers' */
  path: string;
  title: string;
  subtitle?: string;
  /** Singular noun used in toasts and buttons */
  label: string;
  /** RBAC prefix, e.g. 'supplier' */
  resource: string;
  columns: ResourceColumn[];
  defaultSortBy?: string;
  searchPlaceholder?: string;
  /** Rendered above the table — resource-specific filter controls */
  filters?: React.ReactNode;
}

/**
 * One page implementation for every master.
 *
 * The API gives each resource the same endpoint shape, so the UI is written once too.
 * Search, sorting, pagination, archive/restore, Excel/CSV/PDF export, print and the
 * audit-history drawer all come from here — a resource page supplies only its columns.
 */
export function ResourcePage({
  path, title, subtitle, label, resource, columns,
  defaultSortBy, searchPlaceholder, filters,
}: ResourcePageProps) {
  const can = useAuthStore((state) => state.can);
  const { state, update, toggleSort, query, params } = useResourceQuery(path, {
    sortBy: defaultSortBy,
  });
  const { archive, restore } = useResourceMutations(path, label);
  const exportAs = useResourceExport(path, label);

  const [historyId, setHistoryId] = useState<string | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);

  const rows = query.data?.data ?? [];
  const meta = query.data?.meta;
  const visibleColumns = columns;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-0.5 text-sm text-[var(--text-secondary)]">{subtitle}</p>}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {can(`${resource}:import` as Permission) && (
            <Button variant="secondary" size="sm" asChild>
              <a href={`${process.env.NEXT_PUBLIC_API_URL}/${path}/import/template`}>
                <Upload className="h-4 w-4" aria-hidden />
                Import
              </a>
            </Button>
          )}

          {can(`${resource}:export` as Permission) && (
            <div className="relative">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setExportMenuOpen((open) => !open)}
                aria-expanded={exportMenuOpen}
                aria-haspopup="menu"
              >
                <Download className="h-4 w-4" aria-hidden />
                Export
                <ChevronDown className="h-3.5 w-3.5" aria-hidden />
              </Button>
              {exportMenuOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setExportMenuOpen(false)} aria-hidden />
                  <div role="menu" className="glass-strong absolute right-0 z-20 mt-1.5 w-44 rounded-xl p-1.5">
                    {([
                      { format: 'xlsx' as const, label: 'Excel (.xlsx)', icon: FileSpreadsheet },
                      { format: 'csv' as const, label: 'CSV', icon: FileText },
                      { format: 'pdf' as const, label: 'PDF', icon: FileText },
                    ]).map(({ format, label: optionLabel, icon: Icon }) => (
                      <button
                        key={format}
                        role="menuitem"
                        onClick={() => {
                          setExportMenuOpen(false);
                          // Exports honour the filters currently on screen — a report
                          // that silently ignores them is worse than no report.
                          void exportAs(format, params);
                        }}
                        className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-[var(--glass-bg)]"
                      >
                        <Icon className="h-4 w-4 text-[var(--text-muted)]" aria-hidden />
                        {optionLabel}
                      </button>
                    ))}
                    <button
                      role="menuitem"
                      onClick={() => {
                        setExportMenuOpen(false);
                        window.print();
                      }}
                      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-[var(--glass-bg)]"
                    >
                      <Printer className="h-4 w-4 text-[var(--text-muted)]" aria-hidden />
                      Print
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {can(`${resource}:create` as Permission) && (
            <Button size="sm">
              <Plus className="h-4 w-4" aria-hidden />
              New {label}
            </Button>
          )}
        </div>
      </header>

      {/* Toolbar */}
      <GlassCard padding="sm" className="no-print">
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-56 flex-1">
            <Input
              type="search"
              placeholder={searchPlaceholder ?? `Search ${title.toLowerCase()}…`}
              icon={<Search className="h-4 w-4" />}
              value={state.search}
              onChange={(event) => update({ search: event.target.value })}
              aria-label={`Search ${title}`}
            />
          </div>

          {filters}

          <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-[var(--glass-ring)] px-3 py-2 text-sm">
            <input
              type="checkbox"
              checked={state.onlyArchived}
              onChange={(event) =>
                update({ onlyArchived: event.target.checked, includeArchived: false })
              }
              className="h-4 w-4 accent-[var(--color-brand-500)]"
            />
            <Archive className="h-3.5 w-3.5 text-[var(--text-muted)]" aria-hidden />
            Archived
          </label>
        </div>
      </GlassCard>

      {/* Table */}
      <GlassCard padding="none" className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">{title}</caption>
            <thead>
              <tr className="border-b border-[var(--glass-ring)] text-left">
                {visibleColumns.map((column) => (
                  <th
                    key={column.key}
                    scope="col"
                    className={cn(
                      'px-4 py-3 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]',
                      column.align === 'right' && 'text-right',
                      column.hideOnMobile && 'hidden lg:table-cell',
                    )}
                    aria-sort={
                      state.sortBy === column.key
                        ? state.sortDir === 'asc' ? 'ascending' : 'descending'
                        : undefined
                    }
                  >
                    {column.sortable === false ? (
                      column.header
                    ) : (
                      <button
                        onClick={() => toggleSort(column.key)}
                        className={cn(
                          'inline-flex items-center gap-1 hover:text-[var(--text-primary)]',
                          column.align === 'right' && 'flex-row-reverse',
                        )}
                      >
                        {column.header}
                        {state.sortBy === column.key &&
                          (state.sortDir === 'asc' ? (
                            <ChevronUp className="h-3 w-3" aria-hidden />
                          ) : (
                            <ChevronDown className="h-3 w-3" aria-hidden />
                          ))}
                      </button>
                    )}
                  </th>
                ))}
                <th scope="col" className="w-12 px-4 py-3">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>

            <tbody>
              {query.isLoading && (
                <tr>
                  <td colSpan={visibleColumns.length + 1} className="px-4 py-16 text-center">
                    <Loader2 className="mx-auto h-5 w-5 animate-spin text-[var(--text-muted)]" />
                  </td>
                </tr>
              )}

              {query.isError && (
                <tr>
                  <td
                    colSpan={visibleColumns.length + 1}
                    className="px-4 py-12 text-center text-sm text-[var(--status-critical)]"
                  >
                    {(query.error as Error).message}
                  </td>
                </tr>
              )}

              {!query.isLoading && !query.isError && rows.length === 0 && (
                <tr>
                  <td
                    colSpan={visibleColumns.length + 1}
                    className="px-4 py-16 text-center text-sm text-[var(--text-muted)]"
                  >
                    {state.search
                      ? `No ${title.toLowerCase()} match “${state.search}”.`
                      : state.onlyArchived
                        ? `No archived ${title.toLowerCase()}.`
                        : `No ${title.toLowerCase()} yet.`}
                  </td>
                </tr>
              )}

              {rows.map((row) => {
                const id = row.id as string;
                const isArchived = Boolean(row.archivedAt);
                return (
                  <tr
                    key={id}
                    className={cn(
                      'border-b border-[var(--glass-ring)] transition-colors last:border-0 hover:bg-[var(--glass-bg)]',
                      isArchived && 'opacity-60',
                    )}
                  >
                    {visibleColumns.map((column) => (
                      <td
                        key={column.key}
                        className={cn(
                          'px-4 py-3',
                          column.align === 'right' && 'tabular text-right',
                          column.hideOnMobile && 'hidden lg:table-cell',
                        )}
                      >
                        {column.render ? column.render(row) : readPath(row, column.key)}
                      </td>
                    ))}

                    <td className="px-4 py-3 text-right">
                      <div className="relative inline-block">
                        <button
                          onClick={() => setOpenMenuId(openMenuId === id ? null : id)}
                          className="rounded-lg p-1.5 text-[var(--text-muted)] hover:bg-[var(--glass-bg)] hover:text-[var(--text-primary)]"
                          aria-label="Row actions"
                          aria-haspopup="menu"
                        >
                          <MoreVertical className="h-4 w-4" />
                        </button>

                        {openMenuId === id && (
                          <>
                            <div className="fixed inset-0 z-10" onClick={() => setOpenMenuId(null)} aria-hidden />
                            <div role="menu" className="glass-strong absolute right-0 z-20 mt-1 w-48 rounded-xl p-1.5 text-left">
                              <button
                                role="menuitem"
                                onClick={() => {
                                  setHistoryId(id);
                                  setOpenMenuId(null);
                                }}
                                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-[var(--glass-bg)]"
                              >
                                <History className="h-4 w-4 text-[var(--text-muted)]" aria-hidden />
                                Audit history
                              </button>

                              {isArchived
                                ? can(`${resource}:restore` as Permission) && (
                                    <button
                                      role="menuitem"
                                      onClick={() => {
                                        restore.mutate(id);
                                        setOpenMenuId(null);
                                      }}
                                      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-[var(--glass-bg)]"
                                    >
                                      <ArchiveRestore className="h-4 w-4 text-[var(--text-muted)]" aria-hidden />
                                      Restore
                                    </button>
                                  )
                                : can(`${resource}:archive` as Permission) && (
                                    <button
                                      role="menuitem"
                                      onClick={() => {
                                        archive.mutate({ id });
                                        setOpenMenuId(null);
                                      }}
                                      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-[var(--glass-bg)]"
                                    >
                                      <Archive className="h-4 w-4 text-[var(--text-muted)]" aria-hidden />
                                      Archive
                                    </button>
                                  )}
                            </div>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {meta && meta.total > 0 && (
          <div className="no-print flex flex-wrap items-center justify-between gap-3 border-t border-[var(--glass-ring)] px-4 py-3">
            <p className="text-xs text-[var(--text-muted)]">
              Showing{' '}
              <span className="tabular font-medium text-[var(--text-secondary)]">
                {(meta.page - 1) * meta.pageSize + 1}–
                {Math.min(meta.page * meta.pageSize, meta.total)}
              </span>{' '}
              of <span className="tabular font-medium text-[var(--text-secondary)]">{meta.total}</span>
            </p>

            <div className="flex items-center gap-1.5">
              <select
                value={state.pageSize}
                onChange={(event) => update({ pageSize: Number(event.target.value) })}
                aria-label="Rows per page"
                className="h-8 rounded-lg border border-[var(--glass-ring)] bg-[var(--glass-bg)] px-2 text-xs"
              >
                {[25, 50, 100, 200].map((size) => (
                  <option key={size} value={size}>{size} / page</option>
                ))}
              </select>

              <Button
                variant="ghost" size="sm"
                disabled={!meta.hasPrevious}
                onClick={() => update({ page: meta.page - 1 })}
                aria-label="Previous page"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="tabular px-1 text-xs text-[var(--text-secondary)]">
                {meta.page} / {meta.totalPages}
              </span>
              <Button
                variant="ghost" size="sm"
                disabled={!meta.hasNext}
                onClick={() => update({ page: meta.page + 1 })}
                aria-label="Next page"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
      </GlassCard>

      <AuditDrawer path={path} id={historyId} onClose={() => setHistoryId(null)} />
    </div>
  );
}

/** Read a dotted path: "supplier.companyName". */
function readPath(row: Record<string, unknown>, key: string): React.ReactNode {
  const value = key.split('.').reduce<unknown>((acc, segment) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[segment];
    return undefined;
  }, row);

  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function AuditDrawer({
  path, id, onClose,
}: { path: string; id: string | null; onClose: () => void }) {
  const { data, isLoading } = useResourceHistory(path, id);

  return (
    <AnimatePresence>
      {id && (
        <>
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
            aria-hidden
          />
          <motion.aside
            initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 300 }}
            className="glass-strong fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col rounded-l-2xl"
            role="dialog"
            aria-label="Audit history"
          >
            <div className="flex items-center justify-between border-b border-[var(--glass-ring)] px-5 py-4">
              <div>
                <h2 className="font-semibold">Audit history</h2>
                <p className="text-xs text-[var(--text-muted)]">Every change, with who and when</p>
              </div>
              <button
                onClick={onClose}
                className="rounded-lg p-1.5 text-[var(--text-muted)] hover:bg-[var(--glass-bg)]"
                aria-label="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              {isLoading && <Loader2 className="mx-auto mt-8 h-5 w-5 animate-spin text-[var(--text-muted)]" />}

              {!isLoading && (data?.length ?? 0) === 0 && (
                <p className="mt-8 text-center text-sm text-[var(--text-muted)]">
                  No changes recorded yet.
                </p>
              )}

              <ol className="space-y-3">
                {data?.map((entry) => (
                  <li key={entry.id} className="rounded-xl border border-[var(--glass-ring)] p-3">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="rounded-md bg-[var(--color-brand-500)]/12 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-brand-600)]">
                        {entry.action}
                      </span>
                      <time className="text-[11px] text-[var(--text-muted)]">
                        {formatDateTime(entry.createdAt)}
                      </time>
                    </div>

                    <p className="mt-1.5 text-xs text-[var(--text-secondary)]">
                      by {entry.userName ?? 'System'}
                      {entry.ipAddress && ` · ${entry.ipAddress}`}
                    </p>

                    {entry.reason && (
                      <p className="mt-1 text-xs italic text-[var(--text-muted)]">“{entry.reason}”</p>
                    )}

                    {Array.isArray(entry.changes) && entry.changes.length > 0 && (
                      <ul className="mt-2 space-y-1">
                        {entry.changes.map((change, index) => (
                          <li key={`${change.field}-${index}`} className="text-xs">
                            <span className="font-medium">{humanise(change.field)}</span>
                            {': '}
                            <span className="text-[var(--text-muted)] line-through">
                              {display(change.from)}
                            </span>
                            {' → '}
                            <span className="text-[var(--delta-up)]">{display(change.to)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

function humanise(field: string): string {
  return field
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

function display(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'empty';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
