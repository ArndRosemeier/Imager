import { useCallback, useEffect, useRef, useState } from 'react';

import { EmptyState, SaveButton } from '@/components/ui';
import { buttonClass } from '@/components/styles';
import { deleteClip, listClipsOfKind, setClipTags } from '@/db/clipRepo';
import { listTagsInUse } from '@/db/tagRepo';
import type { ClipKind, ClipRequest, StoredClip } from '@/domain/clip';
import { filterImages, tagCounts, type TagMatchMode } from '@/domain/tags';
import { useChat, type ChatPanelState } from '@/features/chat/useChat';
import { clipFileName } from '@/features/clips/clipFile';
import { clipBlockReason, makeClip, selectedClipModel } from '@/features/clips/runClip';
import { TagBar } from '@/features/gallery/TagBar';
import { TagEditor } from '@/features/gallery/TagEditor';
import { voicesOf, type OpenRouterModel } from '@/llm/models';
import { toError } from '@/lib/errors';
import { toastError, toastSuccess } from '@/lib/toast';
import { useObjectUrl } from '@/lib/useObjectUrl';

/**
 * What differs between the Sounds and the Voice tab (docs/17 row 60). They are
 * ONE component over ONE table: a sound and a spoken line are both a clip from
 * one text, rendered by the one speech seam.
 */
const COPY = {
  sound: {
    formTitle: 'New sound',
    textLabel: 'Describe the sound',
    placeholder: 'Heavy wooden door creaking open slowly, then slamming shut in a stone hall…',
    button: 'Make sound',
    working: 'Making the sound…',
    done: 'Your sound is ready',
    failed: 'Could not make the sound',
    listTitle: 'Sounds',
    noun: 'sound',
    emptyTitle: 'No sounds yet.',
    emptyHint: 'Describe what should be heard — the source, the space, how long, how loud.',
    note: 'OpenRouter has no dedicated sound-effects model. Its speech models read your text; ByteDance Seed Audio 1.0 is the one that also renders described sound effects, so pick it in Settings for sounds.',
  },
  voice: {
    formTitle: 'New voice clip',
    textLabel: 'Text to speak',
    placeholder: 'Welcome, traveller. The road ahead is long, but the tavern is warm…',
    button: 'Speak',
    working: 'Speaking…',
    done: 'Your voice clip is ready',
    failed: 'Could not make the voice clip',
    listTitle: 'Voice clips',
    noun: 'voice clip',
    emptyTitle: 'No voice clips yet.',
    emptyHint: 'Type what should be said, pick a voice, and optionally say how.',
    note: null,
  },
} as const;

/** The options a clip was made with, in one line. */
function requestSummary(request: ClipRequest): string {
  return [
    request.voice === null ? null : `voice ${request.voice}`,
    request.instructions === null ? null : `“${request.instructions}”`,
  ]
    .filter((part) => part !== null)
    .join(' · ');
}

/* ------------------------------------------------------------ the form */

/**
 * The form. Keyed by the model in the parent, so a voice one model lists is
 * never carried into a request to a model that does not have it.
 */
function ClipForm({
  kind,
  state,
  model,
  onMade,
}: Readonly<{
  kind: ClipKind;
  state: ChatPanelState;
  model: OpenRouterModel | undefined;
  onMade: () => void;
}>): React.JSX.Element {
  const copy = COPY[kind];
  const [text, setText] = useState('');
  const [voice, setVoice] = useState('');
  const [instructions, setInstructions] = useState('');
  const [working, setWorking] = useState(false);
  const blocked = clipBlockReason(state, kind, text);
  const voices = model === undefined ? [] : voicesOf(model);
  const textId = `${kind}-text`;

  const submit = (): void => {
    if (model === undefined) return;
    const request: ClipRequest = {
      model: model.id,
      text: text.trim(),
      voice: kind === 'voice' && voice.trim() !== '' ? voice.trim() : null,
      instructions: kind === 'voice' && instructions.trim() !== '' ? instructions.trim() : null,
    };
    setWorking(true);
    makeClip({ apiKey: state.settings.openRouterApiKey, kind, request })
      .then(
        () => {
          toastSuccess(copy.done);
          onMade();
        },
        (error: unknown) => {
          toastError(copy.failed, error);
        },
      )
      .finally(() => {
        setWorking(false);
      });
  };

  return (
    <section aria-label={copy.formTitle} className="card flex flex-col gap-3 p-3">
      <h2 className="text-heading text-ink">{copy.formTitle}</h2>
      <p className="text-caption text-muted">
        {model === undefined
          ? `No ${kind} model is ready yet.`
          : `With ${model.name} (${model.id}). Change it in Settings.`}
      </p>
      {copy.note !== null && <p className="text-caption text-muted">{copy.note}</p>}
      <label htmlFor={textId} className="text-label text-ink">
        {copy.textLabel}
      </label>
      <textarea
        id={textId}
        className="field focus-visible:field-focus hover:field-hover"
        rows={4}
        placeholder={copy.placeholder}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
        }}
      />
      {kind === 'voice' && model !== undefined && (
        <>
          <label className="flex flex-col gap-1">
            <span className="text-label text-ink">Voice</span>
            {voices.length > 0 ? (
              <select
                className="field focus-visible:field-focus hover:field-hover"
                value={voice}
                onChange={(e) => {
                  setVoice(e.target.value);
                }}
              >
                <option value="">Model default</option>
                {voices.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="field focus-visible:field-focus hover:field-hover"
                placeholder="This model lists no voices — a voice id it accepts, or empty for its default"
                value={voice}
                onChange={(e) => {
                  setVoice(e.target.value);
                }}
              />
            )}
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-label text-ink">How to say it (optional)</span>
            <input
              className="field focus-visible:field-focus hover:field-hover"
              placeholder="Warm and slow, a little amused"
              value={instructions}
              onChange={(e) => {
                setInstructions(e.target.value);
              }}
            />
          </label>
          <p className="text-caption text-muted">
            Used by models that take delivery instructions (OpenAI, Gemini); others ignore it.
            ElevenLabs v3 and v4 read audio tags like [whispering] inside the text instead.
          </p>
        </>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={buttonClass('primary', 'px-4 py-2 text-body')}
          disabled={blocked !== null || working}
          onClick={submit}
        >
          {working ? copy.working : copy.button}
        </button>
        {blocked !== null && !working && <span className="text-caption text-muted">{blocked}</span>}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------ the list */

function ClipCard({
  clip,
  tagsInUse,
  onSetTags,
  onDeleted,
}: Readonly<{
  clip: StoredClip;
  /** The ONE shared tag vocabulary, for suggestions. */
  tagsInUse: readonly string[];
  onSetTags: (next: string[]) => Promise<void>;
  onDeleted: () => void;
}>): React.JSX.Element {
  const url = useObjectUrl(clip.bytes, clip.mimeType);
  const [confirming, setConfirming] = useState(false);
  const noun = COPY[clip.kind].noun;
  const summary = requestSummary(clip.request);
  return (
    <li className="card flex flex-col gap-2 p-3">
      {url === null ? (
        <p className="text-caption text-muted">Loading audio…</p>
      ) : (
        <audio controls src={url} aria-label={`Play: ${clip.request.text}`} className="w-full" />
      )}
      <p className="text-body whitespace-pre-wrap text-ink">{clip.request.text}</p>
      <p className="text-caption text-muted">
        <span className="font-mono">{clip.request.model}</span>
        {summary === '' ? '' : ` · ${summary}`} · {new Date(clip.createdAt).toLocaleString()}
      </p>
      <TagEditor tags={clip.tags} suggestions={tagsInUse} onChange={onSetTags} onPhoto={false} />
      <div className="flex flex-wrap items-center gap-2">
        <SaveButton
          label="Download"
          buildRequest={() => ({
            fileName: clipFileName(clip),
            mimeType: clip.mimeType,
            buildBytes: () => clip.bytes,
          })}
        />
        {confirming ? (
          <div role="group" aria-label="Confirm delete" className="flex flex-wrap items-center gap-2">
            <span className="text-caption text-ink">Delete this {noun}?</span>
            <button
              type="button"
              className={buttonClass('danger')}
              onClick={() => {
                deleteClip(clip.id).then(onDeleted, (error: unknown) => {
                  toastError(`Could not delete the ${noun}`, error);
                });
              }}
            >
              Yes, delete
            </button>
            <button
              type="button"
              className={buttonClass('secondary')}
              onClick={() => {
                setConfirming(false);
              }}
            >
              Keep it
            </button>
          </div>
        ) : (
          <button
            type="button"
            className={buttonClass('danger')}
            onClick={() => {
              setConfirming(true);
            }}
          >
            Delete
          </button>
        )}
      </div>
    </li>
  );
}

/**
 * The Sounds tab (`kind="sound"`) and the Voice tab (`kind="voice"`), docs/17
 * row 60: the form, and the tab's clips — each with its player, tags, Download
 * and Delete — under the shared tag bar.
 */
export function ClipsArea({ kind }: Readonly<{ kind: ClipKind }>): React.JSX.Element {
  const copy = COPY[kind];
  const { state, error } = useChat();
  const [clips, setClips] = useState<StoredClip[] | null>(null);
  const [tagsInUse, setTagsInUse] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [matchMode, setMatchMode] = useState<TagMatchMode>('AND');
  const mounted = useRef(true);

  const reload = useCallback((): void => {
    Promise.all([listClipsOfKind(kind), listTagsInUse()]).then(
      ([clipRows, tagRows]) => {
        if (!mounted.current) return;
        setClips(clipRows);
        setTagsInUse(tagRows);
      },
      (failure: unknown) => {
        if (mounted.current) setLoadError(toError(failure));
      },
    );
  }, [kind]);

  useEffect(() => {
    mounted.current = true;
    reload();
    return () => {
      mounted.current = false;
    };
  }, [reload]);

  if (error !== null) throw error;
  if (loadError !== null) throw loadError;
  if (state === null || clips === null) {
    return <p className="text-body text-muted">Loading {copy.listTitle.toLowerCase()}…</p>;
  }

  const model = selectedClipModel(state, kind);
  const newestFirst = [...clips].reverse();
  const clipTags = tagCounts(clips);
  const visible = filterImages(newestFirst, selectedTags, matchMode);

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:items-start">
      <ClipForm key={model?.id ?? ''} kind={kind} state={state} model={model} onMade={reload} />
      <section aria-label={copy.listTitle} className="flex min-w-0 flex-col gap-2">
        <h2 className="text-heading text-ink">{copy.listTitle}</h2>
        {clipTags.length > 0 && (
          <TagBar
            tags={clipTags}
            selected={selectedTags}
            mode={matchMode}
            noun={copy.noun}
            onToggle={(tag) => {
              setSelectedTags((current) =>
                current.includes(tag) ? current.filter((entry) => entry !== tag) : [...current, tag],
              );
            }}
            onModeChange={setMatchMode}
            onClear={() => {
              setSelectedTags([]);
            }}
          />
        )}
        {newestFirst.length === 0 ? (
          <EmptyState title={copy.emptyTitle} hint={copy.emptyHint} />
        ) : visible.length === 0 ? (
          <p className="text-body text-muted">No {copy.noun} matches the selected tags.</p>
        ) : (
          <ul className="grid gap-3 xl:grid-cols-2">
            {visible.map((clip) => (
              <ClipCard
                key={clip.id}
                clip={clip}
                tagsInUse={tagsInUse}
                onSetTags={(next) => setClipTags(clip.id, next).then(reload)}
                onDeleted={reload}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
