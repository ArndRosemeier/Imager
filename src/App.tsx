import { useCallback, useRef, useState } from 'react';
import { Toaster } from 'sonner';

import { ThemeToggle } from '@/components/ThemeToggle';
import type { ChatAttachRequest } from '@/features/chat/attachRequest';
import { ChatArea } from '@/features/chat/ChatArea';
import { GenerateArea } from '@/features/generate/GenerateArea';
import { SettingsPanel } from '@/features/settings/SettingsPanel';
import { useTheme } from '@/lib/theme';

const TABS = ['Generate', 'Chat', 'Settings'] as const;
type Tab = (typeof TABS)[number];

/** In-app tabs, no router (static host has no history fallback). */
export function App({ initialTab = 'Generate' }: { initialTab?: Tab }): React.JSX.Element {
  const [tab, setTab] = useState<Tab>(initialTab);
  /**
   * A one-shot "stage this gallery image in the chat composer" request
   * (docs/17 row 17). It lives here because the tab does: the Gallery sits
   * inside `GenerateArea` and the composer in `ChatArea`, and neither may own
   * the other's state.
   */
  const [attachRequest, setAttachRequest] = useState<ChatAttachRequest | null>(null);
  const attachNonce = useRef(0);
  /**
   * Stable identity is load-bearing: `ChatArea`'s consume effect depends on
   * this callback, and an inline arrow would re-run the effect on every App
   * render. Clearing (rather than a flag inside `ChatArea`) is what makes the
   * request one-shot across a remount of the Chat tab.
   */
  const onAttachConsumed = useCallback((nonce: number) => {
    setAttachRequest((current) => (current !== null && current.nonce === nonce ? null : current));
  }, []);
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
        <GenerateArea
          onChat={(imageId) => {
            // A new nonce per click: re-picking the SAME image is a new request.
            attachNonce.current += 1;
            setAttachRequest({ imageId, nonce: attachNonce.current });
            setTab('Chat');
          }}
        />
      ) : tab === 'Chat' ? (
        <ChatArea
          attachRequest={attachRequest ?? undefined}
          onAttachConsumed={onAttachConsumed}
        />
      ) : (
        <SettingsPanel />
      )}
      <Toaster richColors position="top-right" theme={theme} />
    </main>
  );
}
