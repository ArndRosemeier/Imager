import { useState } from 'react';
import { Toaster } from 'sonner';

import { ThemeToggle } from '@/components/ThemeToggle';
import { ChatArea } from '@/features/chat/ChatArea';
import { GenerateArea } from '@/features/generate/GenerateArea';
import { SettingsPanel } from '@/features/settings/SettingsPanel';
import { useTheme } from '@/lib/theme';

const TABS = ['Generate', 'Chat', 'Settings'] as const;
type Tab = (typeof TABS)[number];

/** In-app tabs, no router (static host has no history fallback). */
export function App({ initialTab = 'Generate' }: { initialTab?: Tab }): React.JSX.Element {
  const [tab, setTab] = useState<Tab>(initialTab);
  const theme = useTheme();
  return (
    <main className="min-h-screen w-full bg-canvas px-4 py-6 text-ink sm:px-6 lg:px-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-3xl">
          <h1 className="text-2xl font-bold">Imager</h1>
          <p className="text-muted">Generate and refine images with OpenRouter — local-first.</p>
        </div>
        <ThemeToggle />
      </header>
      <nav role="tablist" aria-label="Sections" className="my-4 flex gap-2">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className="rounded border border-strong px-3 py-1 aria-selected:bg-subtle"
            onClick={() => {
              setTab(t);
            }}
          >
            {t}
          </button>
        ))}
      </nav>
      {tab === 'Generate' ? (
        <GenerateArea />
      ) : tab === 'Chat' ? (
        <ChatArea />
      ) : (
        <SettingsPanel />
      )}
      <Toaster richColors position="top-right" theme={theme} />
    </main>
  );
}
