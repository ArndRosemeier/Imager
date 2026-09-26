import { useEffect, useRef, useState } from 'react';

import { EmptyState } from '@/components/ui';
import { buttonClass, focusRing } from '@/components/styles';
import { getConversation, listConversations } from '@/db/chatRepo';
import { getImage } from '@/db/imageRepo';
import { conversationCost, type ChatMessage, type Conversation } from '@/domain/chat';
import type { StoredImage } from '@/domain/image';
import type { ChatAttachRequest } from '@/features/chat/attachRequest';
import { runChatTurn } from '@/features/chat/runChatTurn';
import { useStagedAttachment } from '@/features/chat/useStagedAttachment';
import { chatBlockReason, useChat } from '@/features/chat/useChat';
import { IMAGE_ACCEPT } from '@/features/refine/reference';
import { useImageUrl } from '@/features/gallery/useImageUrl';
import { toError } from '@/lib/errors';
import { useMinWidth, WIDE_QUERY } from '@/lib/media';
import { toastError } from '@/lib/toast';

/**
 * A small thumb for a staged attachment, so the owner can see what the next
 * turn will actually send.
 */
function AttachedThumb({ image }: Readonly<{ image: StoredImage }>): React.JSX.Element {
  const url = useImageUrl(image);
  if (url === null) return <span className="text-caption text-muted">Loading…</span>;
  return <img src={url} alt={image.prompt} className="size-10 rounded object-cover" />;
}

/** One stored image of an assistant turn, with its object URL. */
function ChatImage({ image }: Readonly<{ image: StoredImage }>): React.JSX.Element {
  const url = useImageUrl(image);
  if (url === null) return <p className="text-caption text-muted">Loading image…</p>;
  return (
    <img
      src={url}
      alt={image.prompt}
      className="max-h-72 max-w-[min(18rem,100%)] rounded-lg border border-strong object-contain"
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
  if (rows === null) return <p className="text-caption text-muted">Loading images…</p>;
  return (
    <div className="mt-2 grid grid-cols-2 gap-2">
      {rows.map((image, index) =>
        image === undefined ? (
          <p key={ids[index]} role="alert" className="text-caption text-danger">
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
        className={`max-w-[min(85%,44rem)] rounded-2xl px-3 py-2 ${
          isUser
            ? 'rounded-br-sm bg-accent-soft text-ink ring-1 ring-accent/30'
            : 'card rounded-bl-sm'
        }`}
      >
        <p className="text-caption text-muted">{isUser ? 'You' : 'Assistant'}</p>
        {message.text !== '' && <p className="text-body whitespace-pre-wrap">{message.text}</p>}
        {message.imageIds.length > 0 && <ChatImages ids={message.imageIds} />}
        {message.error !== null && (
          <p role="alert" className="text-caption text-danger">
            Turn failed: {message.error}
          </p>
        )}
        {message.role === 'assistant' && message.costUsd !== null && (
          <p className="mt-1 text-caption text-muted">Cost: ${message.costUsd.toFixed(4)}</p>
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
    <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <h2 className="min-w-0 truncate text-heading text-ink">{conversation.title}</h2>
      <p className="text-caption text-muted">
        <span className="font-mono">{conversation.model}</span> · total{' '}
        {cost.totalUsd === null ? 'not reported' : `$${cost.totalUsd.toFixed(4)}`}
        {cost.missingTurns > 0 &&
          ` (${String(cost.missingTurns)} turn${cost.missingTurns === 1 ? '' : 's'} without a reported cost)`}
      </p>
    </div>
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
export function ChatArea({
  attachRequest,
  onAttachConsumed,
}: Readonly<{
  /** A gallery image the lightbox asked to stage (docs/17 row 17), or undefined. */
  attachRequest: ChatAttachRequest | undefined;
  /** Called with the staged request's nonce so `App` can clear it (once). */
  onAttachConsumed: (nonce: number) => void;
}>): React.JSX.Element {
  const { state, error } = useChat();
  const [conversations, setConversations] = useState<Conversation[] | null>(null);
  const [open, setOpen] = useState<Conversation | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [pendingText, setPendingText] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const wide = useMinWidth(WIDE_QUERY);

  /**
   * The images attached to the NEXT message ("an image as the base of the
   * chat", ledger row 16) — ONE staging state, fed by BOTH the composer's file
   * control and the gallery lightbox's request (row 17). The state lives in its
   * own hook so there is exactly one such state in `src/`.
   */
  const staging = useStagedAttachment(attachRequest, onAttachConsumed);

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

  // The conversation list is a slide-in sheet only where it would otherwise
  // push the conversation off the screen; Escape closes it there.
  useEffect(() => {
    if (!listOpen || wide) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setListOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [listOpen, wide]);

  if (error !== null) throw error;
  if (loadError !== null) throw loadError;
  if (state === null || conversations === null) {
    return <p className="text-body text-muted">Loading chat…</p>;
  }

  const reason = chatBlockReason(state, draft, staging.attached.length > 0);
  /**
   * The conversation's BASE images: every image attached to a user turn. They
   * are what makes "an image as the base of the chat" true across turns — the
   * first user message's attachment is replayed on every later turn.
   */
  const baseImages = (open?.messages ?? []).flatMap((message) =>
    message.role === 'user' ? message.imageIds : [],
  );

  const onSend = (): void => {
    const text = draft.trim();
    const attachedNow = staging.takeAll();
    const attachIds = attachedNow.map((image) => image.id);
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
      imageIds: attachIds,
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
          // Give the attachments back too: nothing the owner chose is lost.
          staging.restore(attachedNow);
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
    <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[19rem_minmax(0,1fr)] lg:items-start">
      {/*
        The conversation list. On a wide screen it is the left rail; on a narrow
        one it is a sheet over the conversation, opened by the header button and
        closed by Escape or the backdrop. It is ALWAYS rendered (hiding it with
        CSS, never by unmounting), so the open conversation's scroll state
        survives opening and closing the list.
      */}
      <aside
        aria-label="Conversations"
        data-panel={listOpen || wide ? 'open' : 'closed'}
        className={`card conversation-list ${listOpen ? 'conversation-list-sheet' : ''}`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-heading text-ink">Conversations</h2>
          <div className="flex items-center gap-1">
            <button
              type="button"
              className={buttonClass('secondary')}
              onClick={() => {
                setOpenId(null);
                setOpen(null);
                setDraft('');
              }}
            >
              New conversation
            </button>
            <button
              type="button"
              className={`${buttonClass('ghost', focusRing)} lg:hidden`}
              onClick={() => {
                setListOpen(false);
              }}
            >
              Close
            </button>
          </div>
        </div>
        {conversations.length === 0 ? (
          <p className="px-1 py-2 text-body text-muted">
            No conversations yet — type below to start one.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {conversations.map((conversation) => (
              <li key={conversation.id} className="min-w-0">
                <button
                  type="button"
                  aria-current={conversation.id === openId}
                  className={`w-full rounded-lg border border-strong px-2 py-1.5 text-left ${focusRing} hover:border-accent hover:bg-subtle aria-current:border-accent aria-current:bg-accent-soft`}
                  onClick={() => {
                    setOpenId(conversation.id);
                    setListOpen(false);
                  }}
                >
                  <span className="block truncate text-body text-ink">{conversation.title}</span>
                  <span className="block truncate font-mono text-caption text-muted">
                    {conversation.model} · {new Date(conversation.updatedAt).toLocaleString()}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>
      {listOpen && (
        <button
          type="button"
          aria-label="Close the conversation list"
          tabIndex={-1}
          className="panel-backdrop lg:hidden"
          onClick={() => {
            setListOpen(false);
          }}
        />
      )}

      <section
        aria-label="Conversation"
        className="card flex min-h-0 flex-1 flex-col gap-3 p-3 lg:max-h-[calc(100vh-5rem)]"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <button
            type="button"
            className={`${buttonClass('secondary', focusRing)} lg:hidden`}
            onClick={() => {
              setListOpen(true);
            }}
          >
            Conversations
          </button>
          {open === null ? (
            <span className="text-body text-muted">
              No conversation open — type below to start one.
            </span>
          ) : (
            <ConversationView conversation={open} />
          )}
        </div>

        <ol className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
          {open?.messages.map((message) => (
            <MessageRow key={message.id} message={message} />
          ))}
          {pendingText !== null && (
            <li className="flex justify-end">
              <div className="max-w-[min(85%,44rem)] rounded-2xl rounded-br-sm bg-accent-soft px-3 py-2 ring-1 ring-accent/30">
                <p className="text-caption text-muted">You</p>
                <p className="text-body whitespace-pre-wrap">{pendingText}</p>
              </div>
            </li>
          )}
          {busy && (
            <li role="status" className="text-caption text-muted">
              Waiting for {state.settings.refineChatModel}…
            </li>
          )}
          <div ref={bottomRef} />
        </ol>
        {/*
          An empty conversation is a real state, not a blank box: one quiet
          block, then the composer below it. It shows ONLY when there are no
          turns at all — never as a placeholder over content.
        */}
        {open !== null && open.messages.length === 0 && pendingText === null && !busy && (
          <EmptyState
            title="Say what to change."
            hint="Attach a picture, then describe the change — every result lands in the gallery."
          />
        )}

        {baseImages.length > 0 && (
          <p className="chip self-start">
            Base image{baseImages.length === 1 ? '' : 's'}: {String(baseImages.length)} attached —
            every later turn keeps working from {baseImages.length === 1 ? 'it' : 'them'}.
          </p>
        )}
        {staging.attached.length > 0 && (
          <ul aria-label="Attached images" className="flex flex-wrap gap-2">
            {staging.attached.map((image) => (
              <li
                key={image.id}
                className="flex items-center gap-2 rounded-xl border border-strong bg-subtle p-1 pr-2"
              >
                <AttachedThumb image={image} />
                <button
                  type="button"
                  className={`text-caption text-danger ${focusRing}`}
                  aria-label={`Remove attached image ${image.prompt}`}
                  onClick={() => {
                    staging.remove(image.id);
                  }}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex flex-col gap-2 border-t border-strong pt-3">
          <label htmlFor="chat-message" className="text-label text-ink">
            Message
          </label>
          <textarea
            id="chat-message"
            className="field focus-visible:field-focus hover:field-hover"
            rows={3}
            placeholder="Describe the change you want…"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
            }}
          />
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept={IMAGE_ACCEPT}
              aria-label="Attach an image"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file !== undefined) void staging.addFile(file);
              }}
            />
            <button
              type="button"
              className={buttonClass('secondary')}
              disabled={staging.busy || busy}
              onClick={() => {
                fileRef.current?.click();
              }}
            >
              {staging.busy ? 'Attaching…' : 'Attach image'}
            </button>
            <button
              type="button"
              className={buttonClass('primary', 'px-4 py-2 text-body')}
              disabled={reason !== null || busy}
              onClick={onSend}
            >
              {busy ? 'Sending…' : 'Send'}
            </button>
            {busy && (
              <button
                type="button"
                className={buttonClass('secondary')}
                onClick={() => {
                  abortRef.current?.abort(new DOMException('Chat turn cancelled', 'AbortError'));
                }}
              >
                Cancel
              </button>
            )}
            {reason !== null && !busy && <span className="text-caption text-muted">{reason}</span>}
          </div>
          {staging.error !== null && (
            <p role="alert" className="text-caption text-danger">
              {staging.error}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
