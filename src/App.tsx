import { Toaster } from 'sonner';

import { SettingsPanel } from '@/features/settings/SettingsPanel';

/**
 * In-app tabs, no router (static host has no history fallback). One tab
 * today — the tab STATE arrives with the second tab, not before (KISS).
 */
export function App(): React.JSX.Element {
  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="text-2xl font-bold">Imager</h1>
      <p>Generate and refine images with OpenRouter — local-first.</p>
      <nav role="tablist" className="my-4 flex gap-2">
        <button type="button" role="tab" aria-selected className="rounded border px-3 py-1">
          Settings
        </button>
      </nav>
      <SettingsPanel />
      <Toaster richColors position="top-right" />
    </main>
  );
}
