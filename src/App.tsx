import { useCallback, useRef, useState } from 'react';
import { Toaster } from 'sonner';

import { ThemeToggle } from '@/components/ThemeToggle';
import { focusRing } from '@/components/styles';
import type { ChatAttachRequest } from '@/features/chat/attachRequest';
import { ChatArea } from '@/features/chat/ChatArea';
import { GenerateArea } from '@/features/generate/GenerateArea';
import type { Mode } from '@/features/generate/mode';
import { Gallery } from '@/features/gallery/Gallery';
import { SettingsPanel } from '@/features/settings/SettingsPanel';
import { useTheme } from '@/lib/theme';

/**
 * The primary tabs ARE the app's navigation (no router). The order reads as the
 * working pipeline: you make an image (Generate), you look at what you made
 * (Gallery), you talk it further (Chat) — and Settings is the configuration
 * surface, not a step in that flow, so it stays last (docs/17 row 30).
 */
const TABS = ['Generate', 'Gallery', 'Chat', 'Settings'] as const;
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
      className="seg-group order-3 w-full flex-wrap lg:order-none lg:w-auto"
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
 * the active tab's surface below it.
 *
 * In-app tabs, no router: the static host has no history fallback.
 *
 * THREE pieces of state live here because the tab is what decides which surface
 * exists, and a cross-tab action has to set them before (or while) it switches:
 * the one-shot `ChatAttachRequest` for "Chat with this image", and the refine
 * form's mode + source for "Refine this" (docs/17 rows 18 and 30).
 */
export function App({ initialTab = 'Generate' }: { initialTab?: Tab }): React.JSX.Element {
  const [tab, setTab] = useState<Tab>(initialTab);
  /**
   * A one-shot "stage this gallery image in the chat composer" request
   * (docs/17 row 18). It lives here because the tab does: the Gallery and the
   * composer in `ChatArea` are separate surfaces, and neither may own the
   * other's state.
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
  /**
   * The refine form's mode and source (docs/17 row 30). They live here because
   * the Gallery tab's "Refine this" must set BOTH and then select the Generate
   * tab; keeping them inside `GenerateArea` would leave the cross-tab action
   * with nowhere to write. Unlike the chat request this needs no nonce: the
   * source is plain persistent form state, so setting it again (even to the
   * same image) is a no-op rather than a duplicate action.
   */
  const [mode, setMode] = useState<Mode>('Create');
  const [refineSourceId, setRefineSourceId] = useState<string | null>(null);
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
        </div>
        <TabBar
          tab={tab}
          onSelect={(next) => {
            setTab(next);
          }}
        />
      </header>

      {tab === 'Generate' ? (
        <main className="w-full flex-1 px-3 py-3 sm:px-4">
          <GenerateArea
            mode={mode}
            onModeChange={setMode}
            sourceId={refineSourceId}
            onSourceChange={setRefineSourceId}
          />
        </main>
      ) : tab === 'Gallery' ? (
        <main className="w-full flex-1 px-3 py-3 sm:px-4">
          <Gallery
            onRefine={(imageId) => {
              // Land on the Generate tab with THAT image as the refine source,
              // in Refine mode (docs/17 row 30).
              setRefineSourceId(imageId);
              setMode('Refine');
              setTab('Generate');
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
