import { useState } from 'react';
import { Toaster } from 'sonner';

import { GeneratePanel } from '@/features/generate/GeneratePanel';
import { SettingsPanel } from '@/features/settings/SettingsPanel';

const TABS = ['Generate', 'Settings'] as const;
type Tab = (typeof TABS)[number];

/** In-app tabs, no router (static host has no history fallback). */
export function App({ initialTab = 'Generate' }: { initialTab?: Tab }): React.JSX.Element {
  const [tab, setTab] = useState<Tab>(initialTab);
  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="text-2xl font-bold">Imager</h1>
      <p>Generate and refine images with OpenRouter — local-first.</p>
      <nav role="tablist" className="my-4 flex gap-2">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className="rounded border px-3 py-1 aria-selected:bg-gray-200"
            onClick={() => {
              setTab(t);
            }}
          >
            {t}
          </button>
        ))}
      </nav>
      {tab === 'Generate' ? <GeneratePanel /> : <SettingsPanel />}
      <Toaster richColors position="top-right" />
    </main>
  );
}
