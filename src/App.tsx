import { useCallback, useRef, useState } from 'react';
import { Toaster } from 'sonner';

import { ThemeToggle } from '@/components/ThemeToggle';
import { buttonClass, focusRing } from '@/components/styles';
import type { ChatAttachRequest } from '@/features/chat/attachRequest';
import { ChatArea } from '@/features/chat/ChatArea';
import { GenerateArea } from '@/features/generate/GenerateArea';
import { SettingsPanel } from '@/features/settings/SettingsPanel';
import { useTheme } from '@/lib/theme';

const TABS = ['Generate', 'Chat', 'Settings'] as const;
type Tab = (typeof TABS)[number];

/** The primary tabs are the app's whole navigation (no router). */
function TabBar({
  tab,
  onSelect,
}: Readonly<{ tab: Tab; onSelect: (tab: Tab) => void }>): React.JSX.Element {
  return (
    <nav
      role="tablist"
      aria-label="Sections"
      className="seg-group order-3 w-full lg:order-none lg:w-auto"
    >
      {TABS.map((option) => (
        <button
          key={option}
          type="button"
          role="tab"
          aria-selected={tab === option}
          className={`seg-item ${focusRing} ${
            tab === option ? 'seg-item-active' : 'hover:seg-item-hover'
          }`}
          onClick={() => {
            onSelect(option);
          }}
        >
          {option}
        </button>
      ))}
    </nav>
  );
}

/**
 * The app shell: ONE compact bar (identity, the primary tabs, the theme) and
 * the hero surface below it — the gallery, with the controls in a panel beside
 * or over it.
 *
 * In-app tabs, no router: the static host has no history fallback.
 */
export function App({ initialTab = 'Generate' }: { initialTab?: Tab }): React.JSX.Element {
  const [tab, setTab] = useState<Tab>(initialTab);
  /**
   * The controls panel on a NARROW viewport: closed to begin with, so the
   * artwork owns the screen, and one visible button opens it. At `lg` and up
   * the panel is a persistent rail and this flag does not affect visibility.
   */
  const [panelOpen, setPanelOpen] = useState(false);
  /**
   * A one-shot "stage this gallery image in the chat composer" request
   * (docs/17 row 18). It lives here because the tab does: the Gallery sits
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
    <div className="flex min-h-screen flex-col bg-canvas text-ink">
      <header className="sticky top-0 z-20 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-strong bg-canvas/90 px-3 py-2 backdrop-blur sm:px-4">
        <div className="flex min-w-0 items-baseline gap-2">
          <h1 className="text-title text-ink">Imager</h1>
          <p className="hidden text-caption text-muted md:block">
            images in, images out — local-first
          </p>
        </div>
        <div className="order-2 ml-auto flex items-center gap-2">
          <ThemeToggle />
          <button
            type="button"
            aria-expanded={panelOpen}
            className={`${buttonClass('secondary', focusRing)} lg:hidden`}
            onClick={() => {
              setPanelOpen((open) => !open);
            }}
          >
            {panelOpen ? 'Hide controls' : 'Controls'}
          </button>
        </div>
        <TabBar
          tab={tab}
          onSelect={(next) => {
            setTab(next);
          }}
        />
      </header>

      {tab === 'Generate' ? (
        <main
          className={`flex w-full flex-1 flex-col gap-3 px-3 py-3 sm:px-4 lg:flex-row lg:items-start ${
            panelOpen ? 'overflow-hidden lg:overflow-visible' : ''
          }`}
        >
          {/*
            The backdrop for the slide-in panel on a narrow viewport. It sits
            BELOW the panel (lower z, and before it in the DOM) and closes the
            panel when tapped; it is inert from the keyboard (tabIndex -1)
            because the panel's "Close" button is the accessible way out.
          */}
          {panelOpen && (
            <button
              type="button"
              aria-label="Close controls"
              tabIndex={-1}
              className="panel-backdrop lg:hidden"
              onClick={() => {
                setPanelOpen(false);
              }}
            />
          )}
          <GenerateArea
            open={panelOpen}
            onClose={() => {
              setPanelOpen(false);
            }}
            onChat={(imageId) => {
              // A new nonce per click: re-picking the SAME image is a new request.
              attachNonce.current += 1;
              setAttachRequest({ imageId, nonce: attachNonce.current });
              setTab('Chat');
            }}
          />
        </main>
      ) : tab === 'Chat' ? (
        <main className="flex w-full flex-1 flex-col px-3 py-3 sm:px-4">
          <ChatArea
            attachRequest={attachRequest ?? undefined}
            onAttachConsumed={onAttachConsumed}
          />
        </main>
      ) : (
        <main className="w-full flex-1 px-3 py-3 sm:px-4">
          <SettingsPanel />
        </main>
      )}
      <Toaster richColors position="top-right" theme={theme} />
    </div>
  );
}
