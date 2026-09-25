import { useEffect, useRef, useState } from 'react';

import { getConversation, listConversations } from '@/db/chatRepo';
import { getImage } from '@/db/imageRepo';
import { conversationCost, type ChatMessage, type Conversation } from '@/domain/chat';
import type { StoredImage } from '@/domain/image';
import { runChatTurn } from '@/features/chat/runChatTurn';
import { chatBlockReason, useChat } from '@/features/chat/useChat';
import { useImageUrl } from '@/features/gallery/useImageUrl';
import { toError } from '@/lib/errors';
import { toastError } from '@/lib/toast';

/** One stored image of an assistant turn, with its object URL. */
function ChatImage({ image }: Readonly<{ image: StoredImage }>): React.JSX.Element {
  const url = useImageUrl(image);
  if (url === null) return <p className="text-xs text-muted">Loading image…</p>;
  return (
    <img
      src={url}
      alt={image.prompt}
      className="w-full rounded border border-strong object-contain"
    />
  );
}

/**
 * The images an assistant turn produced, by id. An id whose row is gone (the
 * user deleted it from the gallery) is SHOWN as missing — never silently
 * dropped (rule 1); the same condition makes the NEXT turn fail loudly in
 * `runChatTurn`, because the image can no longer be sent back to the model.
 */
function ChatImages({ ids }: Readonly<{ ids: readonly string[] }>): React.JSX.Element {
  const [rows, setRows] = useState<(StoredImage | undefined)[] | null>(null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    let cancelled = false;
    Promise.all(ids.map((id) => getImage(id))).then(
      (loaded) => {
        if (!cancelled) setRows(loaded);
      },
      (loadError: unknown) => {
        if (!cancelled) setError(toError(loadError));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [ids]);
  if (error !== null) throw error;
  if (rows === null) return <p className="text-xs text-muted">Loading images…</p>;
  return (
    <div className="mt-2 grid grid-cols-2 gap-2">
      {rows.map((image, index) =>
        image === undefined ? (
          <p key={ids[index]} role="alert" className="text-xs text-danger">
            A generated image of this turn is no longer in the gallery.
          </p>
        ) : (
          <ChatImage key={image.id} image={image} />
        ),
      )}
    </div>
  );
}

function MessageRow({ message }: Readonly<{ message: ChatMessage }>): React.JSX.Element {
  const isUser = message.role === 'user';
  return (
    <li className={isUser ? 'flex justify-end' : 'flex justify-start'}>
      <div
        className={`max-w-[85%] rounded border border-strong p-2 ${isUser ? 'bg-subtle' : 'bg-surface'}`}
      >
        {message.text !== '' && <p className="whitespace-pre-wrap">{message.text}</p>}
        {message.imageIds.length > 0 && <ChatImages ids={message.imageIds} />}
        {message.error !== null && (
          <p role="alert" className="text-danger">
            Turn failed: {message.error}
          </p>
        )}
        {message.role === 'assistant' && message.costUsd !== null && (
          <p className="mt-1 text-xs text-muted">Cost: ${message.costUsd.toFixed(4)}</p>
        )}
      </div>
    </li>
  );
}

function ConversationView({
  conversation,
}: Readonly<{ conversation: Conversation }>): React.JSX.Element {
  const cost = conversationCost(conversation);
  return (
    <header className="flex flex-wrap items-baseline justify-between gap-2">
      <h2 className="font-semibold">{conversation.title}</h2>
      <p className="text-sm text-muted">
        <span className="font-mono">{conversation.model}</span> · total{' '}
        {cost.totalUsd === null ? 'not reported' : `$${cost.totalUsd.toFixed(4)}`}
        {cost.missingTurns > 0 &&
          ` (${String(cost.missingTurns)} turn${cost.missingTurns === 1 ? '' : 's'} without a reported cost)`}
      </p>
    </header>
  );
}

/**
 * The Chat tab: the conversation list, the open conversation's turns (user text
 * one side, assistant text + its generated images the other), and the composer.
 *
 * The request path is `runChatTurn` → the ONE `src/llm/chat.ts` seam; every
 * generated image lands in the SAME gallery the other paths write to. In-app
 * tabs, no router (the static host has no history fallback).
 */
export function ChatArea(): React.JSX.Element {
  const { state, error } = useChat();
  const [conversations, setConversations] = useState<Conversation[] | null>(null);
  const [open, setOpen] = useState<Conversation | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [pendingText, setPendingText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    listConversations().then(
      (rows) => {
        if (!cancelled) setConversations(rows);
      },
      (listFailure: unknown) => {
        if (!cancelled) setLoadError(toError(listFailure));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [version]);

  useEffect(() => {
    if (openId === null) {
      setOpen(null);
      return;
    }
    let cancelled = false;
    getConversation(openId).then(
      (conversation) => {
        if (!cancelled) setOpen(conversation ?? null);
      },
      (loadFailure: unknown) => {
        if (!cancelled) setLoadError(toError(loadFailure));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [openId, version]);

  // Newest turn at the bottom, kept in view. Guarded with a runtime check:
  // jsdom (the tests' DOM) implements no `scrollIntoView`.
  useEffect(() => {
    const element = bottomRef.current;
    if (element !== null && typeof element.scrollIntoView === 'function') {
      element.scrollIntoView({ block: 'end' });
    }
  }, [open, pendingText, busy]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort(new DOMException('Chat turn cancelled', 'AbortError'));
    };
  }, []);

  if (error !== null) throw error;
  if (loadError !== null) throw loadError;
  if (state === null || conversations === null) return <p>Loading chat…</p>;

  const reason = chatBlockReason(state, draft);

  const onSend = (): void => {
    const text = draft.trim();
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setPendingText(text);
    setDraft('');
    runChatTurn({
      apiKey: state.settings.openRouterApiKey,
      model: state.settings.refineChatModel,
      conversationId: openId,
      text,
      signal: controller.signal,
    })
      .then(
        (result) => {
          setOpen(result.conversation);
          setOpenId(result.conversation.id);
          setPendingText(null);
          setVersion((v) => v + 1);
          // The failed turn is stored AND surfaced here (rule 2); the composer
          // below stays usable.
          if (result.error !== null) toastError('Chat turn failed', result.error);
        },
        (turnFailure: unknown) => {
          // Only reachable when recording the turn itself failed: keep the
          // user's text so nothing they typed is lost.
          setPendingText(null);
          setDraft(text);
          toastError('Chat turn failed', turnFailure);
          setVersion((v) => v + 1);
        },
      )
      .finally(() => {
        setBusy(false);
        abortRef.current = null;
      });
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(18rem,24rem)_minmax(0,1fr)]">
      <aside
        aria-label="Conversations"
        className="flex flex-col gap-2 self-start rounded border border-strong bg-surface p-3"
      >
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-semibold">Conversations</h2>
          <button
            type="button"
            className="rounded border border-strong px-2 py-1 text-sm"
            onClick={() => {
              setOpenId(null);
              setOpen(null);
              setDraft('');
            }}
          >
            New conversation
          </button>
        </div>
        {conversations.length === 0 && <p className="text-sm text-muted">No conversations yet.</p>}
        <ul className="flex flex-col gap-1">
          {conversations.map((conversation) => (
            <li key={conversation.id}>
              <button
                type="button"
                aria-current={conversation.id === openId}
                className="w-full rounded border border-strong px-2 py-1 text-left aria-current:bg-subtle"
                onClick={() => {
                  setOpenId(conversation.id);
                }}
              >
                <span className="block truncate">{conversation.title}</span>
                <span className="block truncate font-mono text-xs text-muted">
                  {conversation.model} · {new Date(conversation.updatedAt).toLocaleString()}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section
        aria-label="Conversation"
        className="flex min-w-0 flex-col gap-3 self-start rounded border border-strong bg-surface p-3"
      >
        {open === null ? (
          <p className="text-muted">
            No conversation open. Type below to start one, or pick one on the left.
          </p>
        ) : (
          <ConversationView conversation={open} />
        )}
        <ol className="flex max-h-[60vh] flex-col gap-3 overflow-auto">
          {open?.messages.map((message) => (
            <MessageRow key={message.id} message={message} />
          ))}
          {pendingText !== null && (
            <li className="flex justify-end">
              <div className="max-w-[85%] rounded border border-strong bg-subtle p-2">
                <p className="whitespace-pre-wrap">{pendingText}</p>
              </div>
            </li>
          )}
          {busy && (
            <li role="status" className="text-sm text-muted">
              Waiting for {state.settings.refineChatModel}…
            </li>
          )}
        </ol>
        <div ref={bottomRef} />

        <label htmlFor="chat-message" className="font-semibold">
          Message
        </label>
        <textarea
          id="chat-message"
          className="rounded border border-strong bg-canvas p-2 text-ink"
          rows={3}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
          }}
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded bg-accent px-3 py-1 text-on-accent disabled:opacity-50"
            disabled={reason !== null || busy}
            onClick={onSend}
          >
            {busy ? 'Sending…' : 'Send'}
          </button>
          {busy && (
            <button
              type="button"
              className="rounded border border-strong px-3 py-1"
              onClick={() => {
                abortRef.current?.abort(new DOMException('Chat turn cancelled', 'AbortError'));
              }}
            >
              Cancel
            </button>
          )}
          {reason !== null && !busy && <span className="text-sm text-muted">{reason}</span>}
        </div>
      </section>
    </div>
  );
}
