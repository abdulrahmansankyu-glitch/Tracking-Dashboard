'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { Loader2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Paginated } from '@intoto/shared';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Add/Edit form for any resource, built from a field descriptor.
 *
 * Deliberately plain: a shopkeeper filling in a new saree wants a short form with
 * sensible defaults, not a forty-field enterprise screen. Each resource lists only the
 * fields that matter at creation time; everything else keeps its default and can be
 * edited later.
 *
 * Validation is left to the API, which already validates with the shared Zod schemas
 * and returns errors keyed by field path — those are mapped straight back onto the
 * inputs, so there is exactly one definition of every rule.
 */

export interface ResourceField {
  name: string;
  label: string;
  type?: 'text' | 'number' | 'currency' | 'select' | 'checkbox' | 'date' | 'textarea' | 'tel' | 'email';
  required?: boolean;
  placeholder?: string;
  hint?: string;
  /** Groups fields under a heading */
  section?: string;
  /** Span both columns */
  wide?: boolean;
  options?: Array<{ value: string; label: string }>;
  /** Populate a select from an API list endpoint */
  optionsFrom?: { path: string; labelKey: string; valueKey?: string; query?: Record<string, string> };
  defaultValue?: string | number | boolean;
}

export interface ResourceFormProps {
  open: boolean;
  onClose: () => void;
  fields: ResourceField[];
  /** The record being edited, or null when creating */
  record: Record<string, unknown> | null;
  label: string;
  saving: boolean;
  onSubmit: (values: Record<string, unknown>) => Promise<void>;
  /** Field-path-keyed errors returned by the API */
  errors?: Record<string, string[]>;
}

export function ResourceForm({
  open, onClose, fields, record, label, saving, onSubmit, errors,
}: ResourceFormProps) {
  const [values, setValues] = useState<Record<string, unknown>>({});

  // Reset whenever the drawer opens or the target record changes, so an edit never
  // shows another record's leftovers.
  useEffect(() => {
    if (!open) return;
    const next: Record<string, unknown> = {};
    for (const field of fields) {
      const existing = readPath(record, field.name);
      next[field.name] =
        existing ?? field.defaultValue ?? (field.type === 'checkbox' ? true : '');
    }
    setValues(next);
  }, [open, record, fields]);

  const sections = useMemo(() => {
    const grouped = new Map<string, ResourceField[]>();
    for (const field of fields) {
      const key = field.section ?? '';
      grouped.set(key, [...(grouped.get(key) ?? []), field]);
    }
    return [...grouped.entries()];
  }, [fields]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    // Empty strings are dropped rather than sent: an optional field left blank must
    // mean "not provided", not "set to empty", or it fails schema validation.
    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(values)) {
      if (value === '' || value === null || value === undefined) continue;
      setPath(payload, key, value);
    }
    await onSubmit(payload);
  }

  return (
    <AnimatePresence>
      {open && (
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
            className="glass-strong fixed inset-y-0 right-0 z-50 flex w-full max-w-2xl flex-col rounded-l-2xl"
            role="dialog"
            aria-label={`${record ? 'Edit' : 'New'} ${label}`}
          >
            <div className="flex items-center justify-between border-b border-[var(--glass-ring)] px-5 py-4">
              <div>
                <h2 className="font-semibold">
                  {record ? `Edit ${label}` : `New ${label}`}
                </h2>
                {record && (
                  <p className="text-xs text-[var(--text-muted)]">
                    {String(record.code ?? record.sku ?? record.name ?? '')}
                  </p>
                )}
              </div>
              <button
                onClick={onClose}
                className="rounded-lg p-1.5 text-[var(--text-muted)] hover:bg-[var(--glass-bg)]"
                aria-label="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="flex flex-1 flex-col overflow-hidden" noValidate>
              <div className="flex-1 space-y-6 overflow-y-auto p-5">
                {sections.map(([section, sectionFields]) => (
                  <fieldset key={section || 'default'}>
                    {section && (
                      <legend className="mb-3 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                        {section}
                      </legend>
                    )}
                    <div className="grid gap-4 sm:grid-cols-2">
                      {sectionFields.map((field) => (
                        <FieldControl
                          key={field.name}
                          field={field}
                          value={values[field.name]}
                          error={errors?.[field.name]?.[0]}
                          onChange={(value) =>
                            setValues((current) => ({ ...current, [field.name]: value }))
                          }
                        />
                      ))}
                    </div>
                  </fieldset>
                ))}

                {/* Errors on fields not shown in this form would otherwise be invisible */}
                {errors &&
                  Object.entries(errors)
                    .filter(([key]) => !fields.some((f) => f.name === key))
                    .map(([key, messages]) => (
                      <p key={key} role="alert" className="text-sm text-[var(--status-critical)]">
                        {key}: {messages.join(', ')}
                      </p>
                    ))}
              </div>

              <div className="flex items-center justify-end gap-2 border-t border-[var(--glass-ring)] px-5 py-4">
                <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
                  Cancel
                </Button>
                <Button type="submit" loading={saving}>
                  {record ? 'Save changes' : `Create ${label.toLowerCase()}`}
                </Button>
              </div>
            </form>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

function FieldControl({
  field, value, error, onChange,
}: {
  field: ResourceField;
  value: unknown;
  error?: string;
  onChange: (value: unknown) => void;
}) {
  const remote = useQuery({
    queryKey: ['options', field.optionsFrom?.path, field.optionsFrom?.query],
    queryFn: () =>
      api.get<Paginated<Record<string, unknown>>>(`/${field.optionsFrom!.path}`, {
        query: { pageSize: 200, ...field.optionsFrom!.query },
      }),
    enabled: Boolean(field.optionsFrom),
    staleTime: 5 * 60_000,
  });

  const options = useMemo(() => {
    if (field.options) return field.options;
    if (!remote.data) return [];
    const { labelKey, valueKey = 'id' } = field.optionsFrom!;
    return remote.data.data.map((row) => ({
      value: String(row[valueKey] ?? ''),
      label: String(row[labelKey] ?? ''),
    }));
  }, [field, remote.data]);

  const wrapper = field.wide ? 'sm:col-span-2' : '';

  if (field.type === 'checkbox') {
    return (
      <label className={cn('flex items-center gap-2.5 self-end pb-2', wrapper)}>
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(event) => onChange(event.target.checked)}
          className="h-4 w-4 accent-[var(--color-brand-500)]"
        />
        <span className="text-sm text-[var(--text-secondary)]">{field.label}</span>
      </label>
    );
  }

  if (field.type === 'select') {
    return (
      <div className={wrapper}>
        <label className="mb-1.5 block text-sm font-medium text-[var(--text-secondary)]">
          {field.label}
          {field.required && <span className="ml-0.5 text-[var(--status-critical)]">*</span>}
        </label>
        <select
          value={String(value ?? '')}
          onChange={(event) => onChange(event.target.value)}
          aria-invalid={error ? true : undefined}
          className={cn(
            'h-11 w-full rounded-xl border bg-[var(--glass-bg)] px-3 text-sm backdrop-blur-md',
            'focus:border-[var(--color-brand-400)] focus:outline-none focus:ring-2 focus:ring-[var(--color-brand-500)]/25',
            error ? 'border-[var(--status-critical)]' : 'border-[var(--glass-ring)]',
          )}
        >
          <option value="">
            {remote.isLoading ? 'Loading…' : field.placeholder ?? 'Select…'}
          </option>
          {options.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        {error && <p role="alert" className="mt-1.5 text-xs text-[var(--status-critical)]">{error}</p>}
        {!error && field.hint && <p className="mt-1.5 text-xs text-[var(--text-muted)]">{field.hint}</p>}
      </div>
    );
  }

  if (field.type === 'textarea') {
    return (
      <div className={cn('sm:col-span-2', wrapper)}>
        <label className="mb-1.5 block text-sm font-medium text-[var(--text-secondary)]">
          {field.label}
        </label>
        <textarea
          rows={3}
          value={String(value ?? '')}
          placeholder={field.placeholder}
          onChange={(event) => onChange(event.target.value)}
          className={cn(
            'w-full rounded-xl border bg-[var(--glass-bg)] p-3 text-sm backdrop-blur-md',
            'focus:border-[var(--color-brand-400)] focus:outline-none focus:ring-2 focus:ring-[var(--color-brand-500)]/25',
            error ? 'border-[var(--status-critical)]' : 'border-[var(--glass-ring)]',
          )}
        />
        {error && <p role="alert" className="mt-1.5 text-xs text-[var(--status-critical)]">{error}</p>}
      </div>
    );
  }

  const inputType =
    field.type === 'number' || field.type === 'currency' ? 'number'
    : field.type === 'date' ? 'date'
    : field.type === 'tel' ? 'tel'
    : field.type === 'email' ? 'email'
    : 'text';

  return (
    <div className={wrapper}>
      <Input
        label={field.label}
        type={inputType}
        inputMode={field.type === 'currency' || field.type === 'number' ? 'decimal' : undefined}
        step={field.type === 'currency' ? '0.01' : undefined}
        required={field.required}
        placeholder={field.placeholder}
        hint={field.hint}
        error={error}
        value={String(value ?? '')}
        onChange={(event) =>
          onChange(
            field.type === 'number' || field.type === 'currency'
              ? event.target.value === '' ? '' : Number(event.target.value)
              : event.target.value,
          )
        }
      />
    </div>
  );
}

/** Read "address.city" from a record. */
function readPath(record: Record<string, unknown> | null, path: string): unknown {
  if (!record) return undefined;
  const direct = record[path];
  if (direct !== undefined) return direct;
  return path.split('.').reduce<unknown>((acc, segment) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[segment];
    return undefined;
  }, record);
}

/** Write "address.city" into a nested payload, creating objects as needed. */
function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  let cursor = target;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const key = segments[i]!;
    cursor[key] ??= {};
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1]!] = value;
}

/** Confirmation prompt for destructive actions. */
export function ConfirmDialog({
  open, title, message, confirmLabel = 'Delete', destructive = true, busy, onConfirm, onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={onCancel}
            className="fixed inset-0 z-[60] bg-black/50 backdrop-blur-sm"
            aria-hidden
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            role="alertdialog"
            aria-label={title}
            className="glass-strong fixed left-1/2 top-1/2 z-[61] w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl p-5"
          >
            <h2 className="text-base font-semibold">{title}</h2>
            <p className="mt-2 text-sm text-[var(--text-secondary)]">{message}</p>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
              <Button variant={destructive ? 'danger' : 'primary'} onClick={onConfirm} loading={busy}>
                {confirmLabel}
              </Button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
