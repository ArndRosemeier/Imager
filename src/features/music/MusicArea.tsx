import { useEffect, useRef, useState } from 'react';

import { EmptyState, SaveButton } from '@/components/ui';
import { buttonClass, focusRing } from '@/components/styles';
import {
  deleteMusicSession,
  deleteSong,
  getMusicSession,
  getSong,
  listMusicSessions,
} from '@/db/musicRepo';
import {
  EMPTY_SONG_SHEET,
  isBlankSheet,
  type MusicMessage,
  type MusicSession,
  type SongSheet,
  type StoredSong,
} from '@/domain/music';
import { useChat } from '@/features/chat/useChat';
import { runMusicTurn, type MusicTurnPhase } from '@/features/music/runMusicTurn';
import { songFileName } from '@/features/music/songFile';
import { renderSheetBlockReason, sendBlockReason } from '@/features/music/useMusic';
import { toError } from '@/lib/errors';
import { useMinWidth, WIDE_QUERY } from '@/lib/media';
import { toastError } from '@/lib/toast';
import { useObjectUrl } from '@/lib/useObjectUrl';

function formatCost(usd: number | null): string {
  return usd === null ? 'not reported' : `$${usd.toFixed(4)}`;
}

/** The player, the download, the delete, and what the model sang. */
function SongPlayer({
  song,
  onDeleted,
}: Readonly<{ song: StoredSong; onDeleted: () => void }>): React.JSX.Element {
  const url = useObjectUrl(song.bytes, song.mimeType);
  return (
    <div className="mt-2 flex flex-col gap-2">
      {url === null ? (
        <p className="text-caption text-muted">Loading audio…</p>
      ) : (
        <audio controls src={url} aria-label={`Play ${song.title}`} className="w-full" />
      )}
      <div className="flex flex-wrap items-center gap-2">
        <SaveButton
          label="Download"
          buildRequest={() => ({
            fileName: songFileName(song),
            mimeType: song.mimeType,
            buildBytes: () => song.bytes,
          })}
        />
        <button
          type="button"
          className={buttonClass('danger')}
          onClick={() => {
            deleteSong(song.id).then(onDeleted, (error: unknown) => {
              toastError('Could not delete the take', error);
            });
          }}
        >
          Delete take
        </button>
        <span className="font-mono text-caption text-muted">{song.model}</span>
        <span className="text-caption text-muted">render {formatCost(song.costUsd)}</span>
      </div>
      {song.transcript.trim() !== '' && (
        <details className="text-caption text-muted">
          <summary className={`cursor-pointer ${focusRing}`}>Lyrics as sung</summary>
          <p className="mt-1 text-body whitespace-pre-wrap text-ink">{song.transcript}</p>
        </details>
      )}
    </div>
  );
}

/**
 * A song of a turn, by id. A song whose row is gone is SHOWN as missing, never
 * silently dropped (rule 1).
 */
function SongById({ id }: Readonly<{ id: string }>): React.JSX.Element {
  const [song, setSong] = useState<StoredSong | null | undefined>(undefined);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    let cancelled = false;
    getSong(id).then(
      (row) => {
        if (!cancelled) setSong(row ?? null);
      },
      (loadError: unknown) => {
        if (!cancelled) setError(toError(loadError));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [id]);
  if (error !== null) throw error;
  if (song === undefined) return <p className="text-caption text-muted">Loading song…</p>;
  if (song === null) {
    return (
      <p role="alert" className="text-caption text-danger">
        The song of this turn is no longer stored.
      </p>
    );
  }
  return (
    <SongPlayer
      song={song}
      onDeleted={() => {
        setSong(null);
      }}
    />
  );
}

function MusicMessageRow({ message }: Readonly<{ message: MusicMessage }>): React.JSX.Element {
  const isUser = message.role === 'user';
  return (
    <li className={isUser ? 'flex justify-end' : 'flex justify-start'}>
      <div
        className={`max-w-[min(85%,44rem)] rounded-2xl px-3 py-2 ${
          isUser
            ? 'rounded-br-sm bg-accent-soft text-ink ring-1 ring-accent/30'
            : 'card w-full rounded-bl-sm'
        }`}
      >
        <p className="text-caption text-muted">{isUser ? 'You' : 'Music'}</p>
        {isUser ? (
          message.action === 'render' ? (
            <p className="text-body text-muted">Render the song sheet as it stands.</p>
          ) : (
            <p className="text-body whitespace-pre-wrap">{message.text}</p>
          )
        ) : (
          <>
            {message.text !== '' && (
              <p className="text-body whitespace-pre-wrap">{message.text}</p>
            )}
            {message.action === 'message' && message.sheet === null && message.error === null && (
              <p className="text-caption text-muted">
                No change to the song sheet, so nothing was rendered — use Render for a new take.
              </p>
            )}
            {message.songId !== '' && <SongById id={message.songId} />}
            {message.error !== null && (
              <p role="alert" className="text-caption text-danger">
                Turn failed: {message.error}
              </p>
            )}
            {message.writerCostUsd !== null && (
              <p className="mt-1 text-caption text-muted">
                Song writer: {formatCost(message.writerCostUsd)}
              </p>
            )}
          </>
        )}
      </div>
    </li>
  );
}

const TEXT_FIELDS: readonly { key: Exclude<keyof SongSheet, 'instrumental' | 'lyrics'>; label: string; placeholder: string }[] = [
  { key: 'title', label: 'Title', placeholder: 'Night Drive' },
  { key: 'style', label: 'Style', placeholder: '80s synthwave, analog synths, gated drums' },
  { key: 'mood', label: 'Mood', placeholder: 'nostalgic, hopeful' },
  { key: 'tempo', label: 'Tempo', placeholder: 'mid-tempo, around 100 BPM' },
  { key: 'instrumentation', label: 'Instrumentation', placeholder: 'synth bass, arpeggios, pads' },
  { key: 'vocals', label: 'Vocals', placeholder: 'airy female lead, harmonies in the chorus' },
  { key: 'length', label: 'Length', placeholder: 'about 2 minutes' },
];

/**
 * The song sheet, editable. It is what every render is made from and what the
 * writer edits — the writer's read of a direction lands HERE, visibly, so a
 * wrong read is fixed by editing a field (AGENTS rule 5).
 */
function SheetEditor({
  sheet,
  onChange,
  disabled,
}: Readonly<{
  sheet: SongSheet;
  onChange: (sheet: SongSheet) => void;
  disabled: boolean;
}>): React.JSX.Element {
  return (
    <fieldset disabled={disabled} className="flex flex-col gap-2">
      <legend className="text-heading text-ink">Song sheet</legend>
      <p className="text-caption text-muted">
        Every render is made from this sheet. Directions rewrite it; you can edit it too. The
        music model cannot edit a finished song, so each render is a new take — melody and voice
        change between takes.
      </p>
      {TEXT_FIELDS.map((field) => (
        <label key={field.key} className="flex flex-col gap-1">
          <span className="text-label text-ink">{field.label}</span>
          <input
            type="text"
            className="field focus-visible:field-focus hover:field-hover"
            placeholder={field.placeholder}
            value={sheet[field.key]}
            onChange={(e) => {
              onChange({ ...sheet, [field.key]: e.target.value });
            }}
          />
        </label>
      ))}
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          className={focusRing}
          checked={sheet.instrumental}
          onChange={(e) => {
            onChange({ ...sheet, instrumental: e.target.checked });
          }}
        />
        <span className="text-label text-ink">Instrumental (no vocals)</span>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-label text-ink">Lyrics</span>
        <textarea
          className="field focus-visible:field-focus hover:field-hover font-mono"
          rows={10}
          placeholder={'[Verse]\n…\n[Chorus]\n…'}
          value={sheet.lyrics}
          onChange={(e) => {
            onChange({ ...sheet, lyrics: e.target.value });
          }}
        />
      </label>
    </fieldset>
  );
}

/**
 * The Music tab (docs/17 row 52): a song list, the open song's turns (each with
 * its player and Download), the editable song sheet, and the composer.
 *
 * A direction goes to the song writer, which rewrites the sheet; the new sheet
 * is then rendered. "Render" renders the sheet as it stands — a new take, or the
 * owner's own edits. Lyria cannot edit a previous song (single-turn, no audio
 * input), so every take is a fresh performance of the sheet.
 */
export function MusicArea(): React.JSX.Element {
  const { state, error } = useChat();
  const [sessions, setSessions] = useState<MusicSession[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [open, setOpen] = useState<MusicSession | null>(null);
  const [sheet, setSheet] = useState<SongSheet>(EMPTY_SONG_SHEET);
  const [draft, setDraft] = useState('');
  const [pendingText, setPendingText] = useState<string | null>(null);
  const [phase, setPhase] = useState<MusicTurnPhase | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [version, setVersion] = useState(0);
  const [loadError, setLoadError] = useState<Error | null>(null);
  // The song whose delete is awaiting confirmation; switching songs drops it.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const wide = useMinWidth(WIDE_QUERY);
  const busy = phase !== null;

  useEffect(() => {
    let cancelled = false;
    listMusicSessions().then(
      (rows) => {
        if (!cancelled) setSessions(rows);
      },
      (listFailure: unknown) => {
        if (!cancelled) setLoadError(toError(listFailure));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [version]);

  // Opening a song loads it AND puts its stored sheet in the editor.
  useEffect(() => {
    if (openId === null) return;
    let cancelled = false;
    getMusicSession(openId).then(
      (session) => {
        if (cancelled) return;
        setOpen(session ?? null);
        setSheet(session?.sheet ?? EMPTY_SONG_SHEET);
      },
      (loadFailure: unknown) => {
        if (!cancelled) setLoadError(toError(loadFailure));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [openId]);

  useEffect(() => {
    const element = bottomRef.current;
    if (element !== null && typeof element.scrollIntoView === 'function') {
      element.scrollIntoView({ block: 'end' });
    }
  }, [open, pendingText, phase]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort(new DOMException('Music turn cancelled', 'AbortError'));
    };
  }, []);

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
  if (state === null || sessions === null) {
    return <p className="text-body text-muted">Loading music…</p>;
  }

  const sendReason = sendBlockReason(state, draft);
  const renderReason = renderSheetBlockReason(state, sheet);

  const startNewSong = (): void => {
    setOpenId(null);
    setOpen(null);
    setSheet(EMPTY_SONG_SHEET);
    setDraft('');
  };

  const deleteOpenSong = (id: string): void => {
    deleteMusicSession(id).then(
      () => {
        startNewSong();
        setVersion((v) => v + 1);
      },
      (deleteFailure: unknown) => {
        toastError('Could not delete the song', deleteFailure);
      },
    );
  };

  const run = (action: 'message' | 'render'): void => {
    const text = action === 'message' ? draft.trim() : '';
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase(action === 'message' ? 'writing' : 'rendering');
    setPendingText(action === 'message' ? text : null);
    if (action === 'message') setDraft('');
    runMusicTurn({
      apiKey: state.settings.openRouterApiKey,
      musicModel: state.settings.musicModel,
      writerModel: state.settings.songWriterModel,
      sessionId: openId,
      action,
      text,
      // A blank sheet is "no sheet yet": the writer starts the song from scratch.
      sheet: isBlankSheet(sheet) ? null : sheet,
      signal: controller.signal,
      onPhase: setPhase,
    })
      .then(
        (result) => {
          setOpen(result.session);
          setOpenId(result.session.id);
          setSheet(result.session.sheet ?? EMPTY_SONG_SHEET);
          setPendingText(null);
          setVersion((v) => v + 1);
          if (result.error !== null) toastError('Music turn failed', result.error);
        },
        (turnFailure: unknown) => {
          // Only reachable when storing the turn failed: give the text back.
          setPendingText(null);
          if (action === 'message') setDraft(text);
          toastError('Music turn failed', turnFailure);
          setVersion((v) => v + 1);
        },
      )
      .finally(() => {
        setPhase(null);
        abortRef.current = null;
      });
  };

  return (
    <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[17rem_minmax(0,1fr)_22rem] lg:items-start">
      <aside
        aria-label="Songs"
        data-panel={listOpen || wide ? 'open' : 'closed'}
        className={`card conversation-list ${listOpen ? 'conversation-list-sheet' : ''}`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-heading text-ink">Songs</h2>
          <div className="flex items-center gap-1">
            <button
              type="button"
              className={buttonClass('secondary')}
              disabled={busy}
              onClick={startNewSong}
            >
              New song
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
        {sessions.length === 0 ? (
          <p className="px-1 py-2 text-body text-muted">No songs yet — describe one to start.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {sessions.map((session) => (
              <li key={session.id} className="min-w-0">
                <button
                  type="button"
                  aria-current={session.id === openId}
                  disabled={busy}
                  className={`w-full rounded-lg border border-strong px-2 py-1.5 text-left ${focusRing} hover:border-accent hover:bg-subtle aria-current:border-accent aria-current:bg-accent-soft`}
                  onClick={() => {
                    setOpenId(session.id);
                    setListOpen(false);
                  }}
                >
                  <span className="block truncate text-body text-ink">{session.title}</span>
                  <span className="block truncate text-caption text-muted">
                    {new Date(session.updatedAt).toLocaleString()}
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
          aria-label="Close the song list"
          tabIndex={-1}
          className="panel-backdrop lg:hidden"
          onClick={() => {
            setListOpen(false);
          }}
        />
      )}

      <section
        aria-label="Song"
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
            Songs
          </button>
          <h2 className="min-w-0 flex-1 truncate text-heading text-ink">
            {open === null ? 'New song' : open.title}
          </h2>
          {open !== null &&
            (confirmDeleteId === open.id ? (
              <div role="group" aria-label="Confirm delete" className="flex flex-wrap items-center gap-2">
                <span className="text-caption text-ink">
                  Delete this song, its chat and all its takes?
                </span>
                <button
                  type="button"
                  className={buttonClass('danger')}
                  onClick={() => {
                    deleteOpenSong(open.id);
                  }}
                >
                  Yes, delete
                </button>
                <button
                  type="button"
                  className={buttonClass('secondary')}
                  onClick={() => {
                    setConfirmDeleteId(null);
                  }}
                >
                  Keep it
                </button>
              </div>
            ) : (
              <button
                type="button"
                className={buttonClass('danger')}
                disabled={busy}
                onClick={() => {
                  setConfirmDeleteId(open.id);
                }}
              >
                Delete song
              </button>
            ))}
        </div>

        <ol className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
          {open?.messages.map((message) => (
            <MusicMessageRow key={message.id} message={message} />
          ))}
          {pendingText !== null && (
            <li className="flex justify-end">
              <div className="max-w-[min(85%,44rem)] rounded-2xl rounded-br-sm bg-accent-soft px-3 py-2 ring-1 ring-accent/30">
                <p className="text-caption text-muted">You</p>
                <p className="text-body whitespace-pre-wrap">{pendingText}</p>
              </div>
            </li>
          )}
          {phase !== null && (
            <li role="status" className="text-caption text-muted">
              {phase === 'writing'
                ? `Writing the song sheet with ${state.settings.songWriterModel}…`
                : `Rendering with ${state.settings.musicModel} — a full song can take a minute or two…`}
            </li>
          )}
          <div ref={bottomRef} />
        </ol>
        {open === null && pendingText === null && !busy && (
          <EmptyState
            title="Describe a song."
            hint="Say what you want to hear — genre, mood, what it is about. Then refine it: “darker”, “add a bridge”, “rewrite the second verse”."
          />
        )}

        <div className="flex flex-col gap-2 border-t border-strong pt-3">
          <label htmlFor="music-message" className="text-label text-ink">
            Direction
          </label>
          <textarea
            id="music-message"
            className="field focus-visible:field-focus hover:field-hover"
            rows={3}
            placeholder={open === null ? 'A melancholic indie-folk song about leaving home…' : 'What should change?'}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
            }}
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={buttonClass('primary', 'px-4 py-2 text-body')}
              disabled={sendReason !== null || busy}
              onClick={() => {
                run('message');
              }}
            >
              {busy ? 'Working…' : 'Send'}
            </button>
            {busy && (
              <button
                type="button"
                className={buttonClass('secondary')}
                onClick={() => {
                  abortRef.current?.abort(new DOMException('Music turn cancelled', 'AbortError'));
                }}
              >
                Cancel
              </button>
            )}
            {sendReason !== null && !busy && (
              <span className="text-caption text-muted">{sendReason}</span>
            )}
          </div>
        </div>
      </section>

      <section aria-label="Song sheet" className="card flex flex-col gap-3 p-3">
        <SheetEditor sheet={sheet} onChange={setSheet} disabled={busy} />
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={buttonClass('secondary')}
            disabled={renderReason !== null || busy}
            onClick={() => {
              run('render');
            }}
          >
            Render
          </button>
          {renderReason !== null && !busy && (
            <span className="text-caption text-muted">{renderReason}</span>
          )}
        </div>
      </section>
    </div>
  );
}
