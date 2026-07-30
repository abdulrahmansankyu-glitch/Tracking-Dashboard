'use client';

import { create } from 'zustand';
import { hasPermission, type Permission, type RoleName } from '@intoto/shared';

import { api, tokenStore } from '@/lib/api';

/** Set when someone signs out on purpose, so demo auto-entry stands down. Tab-scoped. */
export const SIGNED_OUT_KEY = 'intoto.signedOut';

export interface SessionShop {
  id: string;
  name: string;
  code: string;
  stateCode?: string;
}

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  phone?: string | null;
  avatarUrl?: string | null;
  roles: RoleName[];
  permissions: Permission[];
  shops: SessionShop[];
  organization: { id: string; name: string; currency: string; gstin?: string | null };
  twoFactorEnabled: boolean;
  mustChangePassword: boolean;
}

interface LoginResult {
  ok: boolean;
  twoFactorRequired?: boolean;
  message?: string;
}

interface AuthState {
  user: SessionUser | null;
  activeShopId: string | null;
  status: 'idle' | 'loading' | 'authenticated' | 'unauthenticated';

  login: (identifier: string, password: string, twoFactorCode?: string) => Promise<LoginResult>;
  logout: () => Promise<void>;
  hydrate: () => Promise<void>;
  setActiveShop: (shopId: string | null) => void;
  /** Permission check used by both route guards and conditional UI. */
  can: (permission: Permission) => boolean;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  activeShopId: null,
  status: 'idle',

  async login(identifier, password, twoFactorCode) {
    set({ status: 'loading' });
    try {
      const response = await api.post<
        | { accessToken: string; refreshToken: string; user: SessionUser }
        | { twoFactorRequired: true; message: string }
      >('/auth/login', { identifier, password, twoFactorCode }, { anonymous: true });

      if ('twoFactorRequired' in response) {
        set({ status: 'unauthenticated' });
        return { ok: false, twoFactorRequired: true, message: response.message };
      }

      tokenStore.set(response.accessToken, response.refreshToken);

      // A manager assigned to one shop should land in it; an owner (no assignment,
      // meaning all shops) starts org-wide with no shop filter.
      const defaultShop = response.user.shops.length === 1 ? response.user.shops[0]!.id : null;
      tokenStore.setActiveShop(defaultShop);

      set({ user: response.user, activeShopId: defaultShop, status: 'authenticated' });
      return { ok: true };
    } catch (error) {
      set({ status: 'unauthenticated' });
      return { ok: false, message: (error as Error).message };
    }
  },

  async logout() {
    try {
      await api.post('/auth/logout', { refreshToken: tokenStore.refresh });
    } catch {
      // A failed revoke must not trap the user in a session they asked to leave.
    }
    tokenStore.clear();
    // Remembered for this tab only. Demo builds sign in automatically on arrival, and
    // without this the sign-out button would hand the user straight back to the dashboard
    // they just left. Cleared when someone signs in deliberately.
    if (typeof window !== 'undefined') sessionStorage.setItem(SIGNED_OUT_KEY, '1');
    set({ user: null, activeShopId: null, status: 'unauthenticated' });
  },

  async hydrate() {
    if (!tokenStore.access) {
      set({ status: 'unauthenticated' });
      return;
    }
    set({ status: 'loading' });
    try {
      const user = await api.get<SessionUser>('/auth/me');
      set({
        user,
        activeShopId: tokenStore.activeShopId,
        status: 'authenticated',
      });
    } catch {
      tokenStore.clear();
      set({ user: null, status: 'unauthenticated' });
    }
  },

  setActiveShop(shopId) {
    tokenStore.setActiveShop(shopId);
    set({ activeShopId: shopId });
  },

  can(permission) {
    const user = get().user;
    return user ? hasPermission(user.permissions, permission) : false;
  },
}));
