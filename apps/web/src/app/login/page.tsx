'use client';

import { motion } from 'framer-motion';
import { ArrowRight, KeyRound, Loader2, Lock, ShieldCheck, User } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { GlassCard } from '@/components/ui/glass-card';
import { Input } from '@/components/ui/input';
import { SIGNED_OUT_KEY, useAuthStore } from '@/stores/auth-store';

/**
 * Demo mode: open the app without typing credentials.
 *
 * Off unless the deployment sets it, because it puts a working password in the browser
 * bundle — fine while the database holds nothing but seed data, not once real sales are
 * in it. Turning it off is one environment variable, and the normal sign-in form below
 * is always present either way.
 */
const DEMO_ENTRY = process.env.NEXT_PUBLIC_DEMO_LOGIN === 'true';
const DEMO_EMAIL = process.env.NEXT_PUBLIC_DEMO_EMAIL ?? 'owner@intoto.in';
const DEMO_PASSWORD = process.env.NEXT_PUBLIC_DEMO_PASSWORD ?? 'Intoto@2025';

export default function LoginPage() {
  const router = useRouter();
  const { login, status, hydrate } = useAuthStore();

  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [twoFactorCode, setTwoFactorCode] = useState('');
  const [needsTwoFactor, setNeedsTwoFactor] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [entering, setEntering] = useState(false);

  // Someone arriving with a live session should not be asked to sign in again.
  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  const enterDemo = useCallback(async () => {
    setEntering(true);
    setError(null);
    sessionStorage.removeItem(SIGNED_OUT_KEY);

    const result = await login(DEMO_EMAIL, DEMO_PASSWORD);
    if (result.ok) {
      router.replace('/dashboard');
      return;
    }

    setError(result.message ?? 'Could not open the demo — sign in below');
    setEntering(false);
  }, [login, router]);

  // Straight in, no form. Skipped after a deliberate sign-out; otherwise the sign-out
  // button would return the user to the dashboard they just left. Runs once — a failure
  // leaves status unchanged, so this does not retry in a loop.
  useEffect(() => {
    if (!DEMO_ENTRY || status !== 'unauthenticated') return;
    if (sessionStorage.getItem(SIGNED_OUT_KEY)) return;
    void enterDemo();
  }, [status, enterDemo]);

  useEffect(() => {
    if (status === 'authenticated') router.replace('/dashboard');
  }, [status, router]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    const result = await login(identifier, password, twoFactorCode || undefined);

    if (result.twoFactorRequired) {
      setNeedsTwoFactor(true);
      setSubmitting(false);
      toast.info(result.message ?? 'Enter your authentication code');
      return;
    }

    if (result.ok) {
      sessionStorage.removeItem(SIGNED_OUT_KEY);
      toast.success('Welcome back');
      router.replace('/dashboard');
      return;
    }

    setError(result.message ?? 'Sign in failed');
    setSubmitting(false);
  }

  if (status === 'idle' || status === 'authenticated' || entering) {
    return (
      <main className="grid min-h-screen place-items-center">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-6 w-6 animate-spin text-[var(--text-muted)]" aria-label="Loading" />
          {entering && (
            <p className="text-sm text-[var(--text-secondary)]">Opening Intoto ERP…</p>
          )}
        </div>
      </main>
    );
  }

  return (
    <main className="grid min-h-screen place-items-center p-4">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
        className="w-full max-w-md"
      >
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-2xl bg-gradient-to-br from-[var(--color-brand-500)] to-[var(--color-brand-700)] shadow-lg shadow-[var(--color-brand-500)]/30">
            <span className="text-2xl font-bold text-white">I</span>
          </div>
          <h1 className="text-3xl font-bold tracking-tight">Intoto ERP</h1>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">
            Clothing wholesale &amp; retail management
          </p>
        </div>

        <GlassCard variant="strong" padding="lg">
          {DEMO_ENTRY && (
            <div className="mb-5">
              <Button size="lg" className="w-full" onClick={() => void enterDemo()}>
                Open Intoto ERP
                <ArrowRight className="h-4 w-4" aria-hidden />
              </Button>
              <p className="mt-2 text-center text-xs text-[var(--text-muted)]">
                Opens the owner account with sample shops, stock and customers
              </p>
              <div className="mt-5 flex items-center gap-3">
                <span className="h-px flex-1 bg-[var(--glass-ring)]" />
                <span className="text-xs text-[var(--text-muted)]">or sign in</span>
                <span className="h-px flex-1 bg-[var(--glass-ring)]" />
              </div>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <Input
              label="Email or mobile"
              type="text"
              inputMode="email"
              autoComplete="username"
              placeholder="owner@intoto.in"
              icon={<User className="h-4 w-4" />}
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              required
              autoFocus
              disabled={needsTwoFactor}
            />

            <Input
              label="Password"
              type="password"
              autoComplete="current-password"
              placeholder="••••••••••"
              icon={<Lock className="h-4 w-4" />}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              disabled={needsTwoFactor}
            />

            {needsTwoFactor && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                transition={{ duration: 0.25 }}
              >
                <Input
                  label="Authentication code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123456"
                  maxLength={6}
                  icon={<ShieldCheck className="h-4 w-4" />}
                  value={twoFactorCode}
                  onChange={(e) => setTwoFactorCode(e.target.value.replace(/\D/g, ''))}
                  hint="6-digit code from your authenticator app, or a backup code"
                  required
                  autoFocus
                />
              </motion.div>
            )}

            {error && (
              <div
                role="alert"
                className="rounded-xl border border-[var(--status-critical)]/30 bg-[var(--status-critical)]/10 px-3.5 py-2.5 text-sm text-[var(--status-critical)]"
              >
                {error}
              </div>
            )}

            <Button type="submit" size="lg" className="w-full" loading={submitting}>
              <KeyRound className="h-4 w-4" aria-hidden />
              {needsTwoFactor ? 'Verify and sign in' : 'Sign in'}
            </Button>
          </form>
        </GlassCard>

        <p className="mt-6 text-center text-xs text-[var(--text-muted)]">
          Protected by two-factor authentication and full audit logging
        </p>
      </motion.div>
    </main>
  );
}
