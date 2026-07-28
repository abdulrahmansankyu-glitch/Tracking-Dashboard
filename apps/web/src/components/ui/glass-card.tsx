'use client';

import { motion, type HTMLMotionProps } from 'framer-motion';
import { forwardRef } from 'react';

import { cn } from '@/lib/utils';

interface GlassCardProps extends HTMLMotionProps<'div'> {
  /** `strong` is for surfaces that sit above other glass (modals, the sidebar) */
  variant?: 'default' | 'strong';
  /** Lift and brighten on pointer hover */
  interactive?: boolean;
  /** Specular highlight along the top edge */
  sheen?: boolean;
  padding?: 'none' | 'sm' | 'md' | 'lg';
}

const PADDING = {
  none: '',
  sm: 'p-3',
  md: 'p-5',
  lg: 'p-7',
} as const;

export const GlassCard = forwardRef<HTMLDivElement, GlassCardProps>(function GlassCard(
  { className, variant = 'default', interactive = false, sheen = true, padding = 'md', children, ...props },
  ref,
) {
  return (
    <motion.div
      ref={ref}
      className={cn(
        variant === 'strong' ? 'glass-strong' : 'glass',
        sheen && 'glass-sheen',
        'rounded-2xl',
        PADDING[padding],
        interactive && 'cursor-pointer transition-shadow duration-300 hover:shadow-lg',
        className,
      )}
      {...(interactive
        ? {
            whileHover: { y: -3, transition: { type: 'spring', stiffness: 400, damping: 25 } },
            whileTap: { scale: 0.995 },
          }
        : {})}
      {...props}
    >
      {children}
    </motion.div>
  );
});
