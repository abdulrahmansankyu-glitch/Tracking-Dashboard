'use client';

import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { forwardRef } from 'react';

import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-xl font-medium transition-all ' +
    'disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-2 ' +
    'focus-visible:outline-offset-2 focus-visible:outline-[var(--color-brand-500)] ' +
    'whitespace-nowrap',
  {
    variants: {
      variant: {
        primary:
          'bg-gradient-to-br from-[var(--color-brand-500)] to-[var(--color-brand-600)] text-white ' +
          'shadow-lg shadow-[var(--color-brand-500)]/25 hover:shadow-xl hover:shadow-[var(--color-brand-500)]/35 ' +
          'hover:-translate-y-0.5 active:translate-y-0',
        secondary:
          'glass text-[var(--text-primary)] hover:bg-[var(--glass-bg-strong)]',
        ghost:
          'text-[var(--text-secondary)] hover:bg-[var(--glass-bg)] hover:text-[var(--text-primary)]',
        // Destructive uses the reserved critical status colour, never a series colour.
        danger:
          'bg-[var(--status-critical)] text-white hover:brightness-110 shadow-lg shadow-[var(--status-critical)]/25',
        outline:
          'border border-[var(--glass-ring)] bg-transparent text-[var(--text-primary)] hover:bg-[var(--glass-bg)]',
      },
      size: {
        sm: 'h-8 px-3 text-xs',
        md: 'h-10 px-4 text-sm',
        lg: 'h-12 px-6 text-base',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, asChild = false, loading = false, disabled, children, ...props },
  ref,
) {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp
      ref={ref}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? (
        <>
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          <span>{children}</span>
        </>
      ) : (
        children
      )}
    </Comp>
  );
});

export { buttonVariants };
