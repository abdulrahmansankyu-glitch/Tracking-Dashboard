import { redirect } from 'next/navigation';

/** The app has no marketing surface — the root is the dashboard, behind auth. */
export default function RootPage() {
  redirect('/dashboard');
}
