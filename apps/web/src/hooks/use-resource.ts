'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import type { FilterCondition, Paginated } from '@intoto/shared';

import { ApiError, api } from '@/lib/api';

/**
 * List/mutate hooks for any resource served by the API's CRUD controller.
 *
 * The backend gives every resource an identical endpoint shape, so the client needs one
 * implementation rather than one per page. A page supplies the path; everything else —
 * search, filters, sorting, pagination, archive, export — comes from here.
 */

export interface ResourceQueryState {
  page: number;
  pageSize: number;
  search: string;
  sortBy?: string;
  sortDir: 'asc' | 'desc';
  filters: FilterCondition[];
  includeArchived: boolean;
  onlyArchived: boolean;
}

const INITIAL_STATE: ResourceQueryState = {
  page: 1,
  pageSize: 25,
  search: '',
  sortDir: 'asc',
  filters: [],
  includeArchived: false,
  onlyArchived: false,
};

export function useResourceQuery(path: string, initial?: Partial<ResourceQueryState>) {
  const [state, setState] = useState<ResourceQueryState>(() => ({
    ...INITIAL_STATE,
    ...initial,
    // Seed from ?search= so a link into this page (the topbar search, a bookmark, a
    // shared URL) lands with the term already applied. Read from location rather than
    // useSearchParams to avoid forcing a Suspense boundary on every resource page.
    ...(typeof window !== 'undefined'
      ? { search: new URLSearchParams(window.location.search).get('search') ?? initial?.search ?? '' }
      : {}),
  }));

  const params = useMemo(
    () => ({
      page: state.page,
      pageSize: state.pageSize,
      search: state.search || undefined,
      sortBy: state.sortBy,
      sortDir: state.sortDir,
      filters: state.filters.length ? JSON.stringify(state.filters) : undefined,
      includeArchived: state.includeArchived || undefined,
      onlyArchived: state.onlyArchived || undefined,
    }),
    [state],
  );

  const query = useQuery({
    queryKey: [path, params],
    queryFn: () => api.get<Paginated<Record<string, unknown>>>(`/${path}`, { query: params }),
    // Keeps the previous page visible while the next loads, so the table does not
    // collapse to a spinner on every keystroke or page change.
    placeholderData: (previous) => previous,
  });

  /** Any change other than paging returns to page 1 — otherwise a search can land on an empty page 7. */
  const update = useCallback((patch: Partial<ResourceQueryState>) => {
    setState((current) => ({
      ...current,
      ...patch,
      page: patch.page ?? (Object.keys(patch).some((k) => k !== 'page') ? 1 : current.page),
    }));
  }, []);

  const toggleSort = useCallback((field: string) => {
    setState((current) => ({
      ...current,
      sortBy: field,
      sortDir: current.sortBy === field && current.sortDir === 'asc' ? 'desc' : 'asc',
      page: 1,
    }));
  }, []);

  return { state, update, toggleSort, query, params };
}

export function useResourceMutations(path: string, label: string) {
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: [path] });

  const onError = (error: unknown) => {
    const message =
      error instanceof ApiError
        ? [error.message, ...Object.values(error.details ?? {}).flat()].join(' — ')
        : (error as Error).message;
    toast.error(message);
  };

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post(`/${path}`, body),
    onSuccess: () => {
      toast.success(`${label} created`);
      void invalidate();
    },
    onError,
  });

  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api.patch(`/${path}/${id}`, body),
    onSuccess: () => {
      toast.success(`${label} updated`);
      void invalidate();
    },
    onError,
  });

  const archive = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      api.post(`/${path}/${id}/archive`, { reason }),
    onSuccess: () => {
      toast.success(`${label} archived`);
      void invalidate();
    },
    onError,
  });

  const restore = useMutation({
    mutationFn: (id: string) => api.post(`/${path}/${id}/restore`),
    onSuccess: () => {
      toast.success(`${label} restored`);
      void invalidate();
    },
    onError,
  });

  const remove = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      api.delete(`/${path}/${id}`, { query: { reason } }),
    onSuccess: () => {
      toast.success(`${label} deleted`);
      void invalidate();
    },
    onError,
  });

  return { create, update, archive, restore, remove };
}

export interface AuditEntry {
  id: string;
  action: string;
  userName: string | null;
  changes: Array<{ field: string; from: unknown; to: unknown }> | null;
  reason: string | null;
  ipAddress: string | null;
  createdAt: string;
}

export function useResourceHistory(path: string, id: string | null) {
  return useQuery({
    queryKey: [path, id, 'history'],
    queryFn: () => api.get<AuditEntry[]>(`/${path}/${id}/history`),
    enabled: Boolean(id),
  });
}

/** Download an export honouring the filters currently applied to the table. */
export function useResourceExport(path: string, label: string) {
  return useCallback(
    async (format: 'xlsx' | 'csv' | 'pdf', params: Record<string, unknown>) => {
      const toastId = toast.loading(`Preparing ${format.toUpperCase()} export…`);
      try {
        await api.download(
          `/${path}/export`,
          `${path}.${format}`,
          { query: { ...params, format } as Record<string, string | number | boolean | undefined> },
        );
        toast.success(`${label} exported`, { id: toastId });
      } catch (error) {
        toast.error(`Export failed: ${(error as Error).message}`, { id: toastId });
      }
    },
    [path, label],
  );
}
