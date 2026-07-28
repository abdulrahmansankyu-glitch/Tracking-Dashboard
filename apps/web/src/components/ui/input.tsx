'use client';

import { forwardRef, useId } from 'react';

import { cn } from '@/lib/utils';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  hint?: string;
  icon?: React.ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, label, error, hint, icon, id, ...props },
  ref,
) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const describedBy = error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined;

  return (
    <div className="w-full">
      {label && (
        <label
          htmlFor={inputId}
          className="mb-1.5 block text-sm font-medium text-[var(--text-secondary)]"
        >
          {label}
          {props.required && (
            <span className="ml-0.5 text-[var(--status-critical)]" aria-hidden>
              *
            </span>
          )}
        </label>
      )}

      <div className="relative">
        {icon && (
          <span
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]"
            aria-hidden
          >
            {icon}
          </span>
        )}
        <input
          ref={ref}
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn(
            'h-11 w-full rounded-xl border bg-[var(--glass-bg)] px-3.5 text-sm',
            'text-[var(--text-primary)] placeholder:text-[var(--text-muted)]',
            'backdrop-blur-md transition-all',
            'focus:border-[var(--color-brand-400)] focus:outline-none focus:ring-2 focus:ring-[var(--color-brand-500)]/25',
            icon && 'pl-10',
            error
              ? 'border-[var(--status-critical)] focus:border-[var(--status-critical)] focus:ring-[var(--status-critical)]/25'
              : 'border-[var(--glass-ring)]',
            className,
          )}
          {...props}
        />
      </div>

      {/* Errors are announced: a validation message a screen reader never reaches
          leaves the user stuck on a form with no idea why it will not submit. */}
      {error && (
        <p id={`${inputId}-error`} role="alert" className="mt-1.5 text-xs text-[var(--status-critical)]">
          {error}
        </p>
      )}
      {!error && hint && (
        <p id={`${inputId}-hint`} className="mt-1.5 text-xs text-[var(--text-muted)]">
          {hint}
        </p>
      )}
    </div>
  );
});
