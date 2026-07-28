'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { Toaster } from 'sonner';

import { ApiError } from '@/lib/api';

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Dashboard figures are read constantly as staff move between screens;
            // a short stale window avoids re-fetching the same totals every click
            // without ever showing yesterday's numbers.
            staleTime: 30_000,
            gcTime: 5 * 60_000,
            refetchOnWindowFocus: false,
            retry: (failureCount, error) => {
              // Never retry a rejection the user must act on — wrong permission,
              // missing record, failed validation.
              if (error instanceof ApiError && error.statusCode < 500) return false;
              return failureCount < 2;
            },
          },
          mutations: { retry: false },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      <Toaster
        position="top-right"
        richColors
        closeButton
        toastOptions={{
          style: {
            background: 'var(--glass-bg-strong)',
            backdropFilter: 'blur(20px)',
            border: '1px solid var(--glass-border)',
            color: 'var(--text-primary)',
          },
        }}
      />
    </QueryClientProvider>
  );
}
