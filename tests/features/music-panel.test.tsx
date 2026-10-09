import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { App } from '@/App';
import { db } from '@/db/db';
import { updateSettings } from '@/db/settingsRepo';
import { EMPTY_SONG_SHEET, renderPrompt, type SongSheet } from '@/domain/music';
import { SONG_WRITER_BRIEF } from '@/features/music/songWriter';
import { resetModelCache } from '@/llm/models';
import { base64FromBytes } from '@/lib/base64';
import { jsonResponse } from '../helpers';

/**
 * The Music tab end to end (docs/17 row 52). The model list is
 * `tests/fixtures/models-music.json`: the two Lyria entries and GPT Audio are
 * RECONSTRUCTED from OpenRouter's public `/models?output_modalities=audio`
 * listing as read on 2026-10-09 (modalities, supported parameters, the per-song
 * price living only in the description); the Llama and Nano Banana rows are
 * copied from the real snapshot in `models-trimmed.json`.
 */
const modelsJson = readFileSync('tests/fixtures/models-music.json', 'utf8');
const MUSIC_MODEL = 'google/lyria-3-pro-preview';
const WRITER_MODEL = 'meta-llama/llama-3.3-70b-instruct';
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 7, 7, 7]);

const NIGHT_DRIVE: SongSheet = {
  ...EMPTY_SONG_SHEET,
  title: 'Night Drive',
  style: '80s synthwave',
  mood: 'nostalgic',
  vocals: 'airy female lead',
  length: 'about 2 minutes',
  lyrics: '[Verse]\nNeon on the water',
};

interface Post {
  body: Record<string, unknown>;
}
let writerPosts: Post[] = [];
let renderPosts: Post[] = [];
let writerAnswers: (() => Response)[] = [];
let renderAnswers: (() => Response)[] = [];

function sse(events: readonly unknown[]): Response {
  const text = [...events.map((e) => `data: ${JSON.stringify(e)}\n\n`), 'data: [DONE]\n\n'].join('');
  return new Response(text, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function song(transcript = '[Verse]\nNeon on the water'): () => Response {
  return () =>
    sse([
      { model: MUSIC_MODEL, choices: [{ delta: { audio: { data: base64FromBytes(new Uint8Array(MP3)), transcript } } }] },
      { choices: [{ delta: {} }], usage: { cost: 0.08 } },
    ]);
}

function writes(summary: string, sheet: SongSheet | null): () => Response {
  return () =>
    jsonResponse({
      model: WRITER_MODEL,
      choices: [{ message: { role: 'assistant', content: JSON.stringify({ summary, sheet }) } }],
      usage: { cost: 0.001 },
    });
}

function stubFetch(): void {
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    if (url.endsWith('/models?output_modalities=all')) return Promise.resolve(new Response(modelsJson));
    if (url.endsWith('/chat/completions')) {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
        string,
        unknown
      >;
      const streamed = body.stream === true;
      (streamed ? renderPosts : writerPosts).push({ body });
      const next = (streamed ? renderAnswers : writerAnswers).shift();
      if (next === undefined) return Promise.reject(new Error('no answer queued'));
      return Promise.resolve(next());
    }
    return Promise.reject(new Error(`unexpected ${url}`));
  });
}

async function configure(patch: Record<string, string> = {}): Promise<void> {
  await updateSettings({
    openRouterApiKey: 'sk',
    musicModel: MUSIC_MODEL,
    songWriterModel: WRITER_MODEL,
    ...patch,
  });
}

async function direct(user: ReturnType<typeof userEvent.setup>, text: string): Promise<void> {
  await user.type(await screen.findByLabelText('Direction'), text);
  await user.click(screen.getByRole('button', { name: 'Send' }));
}

function sheetPanel(): HTMLElement {
  return screen.getByRole('region', { name: 'Song sheet' });
}

beforeEach(async () => {
  resetModelCache();
  await Promise.all([db.settings.clear(), db.songs.clear(), db.musicSessions.clear()]);
  writerPosts = [];
  renderPosts = [];
  writerAnswers = [];
  renderAnswers = [];
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it('a direction is READ by the writer into a sheet, which is SHOWN, rendered, stored and downloadable', async () => {
  await configure();
  writerAnswers.push(writes('Started a synthwave song about a night drive.', NIGHT_DRIVE));
  renderAnswers.push(song());
  render(<App initialTab="Music" />);
  const user = userEvent.setup();
  await direct(user, 'A nostalgic synthwave song about driving at night');

  // The writer's read is NAMED on screen (rule 5) …
  expect(
    await screen.findByText('Started a synthwave song about a night drive.'),
  ).toBeInTheDocument();
  // … and lands in the editable sheet.
  expect(within(sheetPanel()).getByLabelText('Title')).toHaveValue('Night Drive');
  expect(within(sheetPanel()).getByLabelText('Lyrics')).toHaveValue('[Verse]\nNeon on the water');

  // The writer call: text out, a STRICT json_schema, the brief, no sheet yet, and
  // the direction verbatim — never pattern-parsed by the app.
  expect(writerPosts).toHaveLength(1);
  const writer = writerPosts[0]?.body ?? {};
  expect(writer.model).toBe(WRITER_MODEL);
  expect(writer.modalities).toEqual(['text']);
  expect(writer.response_format).toMatchObject({
    type: 'json_schema',
    json_schema: { name: 'song_sheet_edit', strict: true },
  });
  expect(writer.messages).toEqual([
    { role: 'system', content: SONG_WRITER_BRIEF },
    {
      role: 'user',
      content: 'Current sheet:\nnull\n\nDirection:\nA nostalgic synthwave song about driving at night',
    },
  ]);

  // The render call carries exactly the sheet's prompt.
  expect(renderPosts).toHaveLength(1);
  expect(renderPosts[0]?.body.messages).toEqual([
    { role: 'user', content: renderPrompt(NIGHT_DRIVE) },
  ]);

  // Stored: one song with its sheet, prompt and transcript; one session.
  const songs = await db.songs.toArray();
  expect(songs).toHaveLength(1);
  expect(songs[0]).toMatchObject({
    mimeType: 'audio/mpeg',
    title: 'Night Drive',
    sheet: NIGHT_DRIVE,
    prompt: renderPrompt(NIGHT_DRIVE),
    transcript: '[Verse]\nNeon on the water',
    model: MUSIC_MODEL,
    costUsd: 0.08,
  });
  expect([...(songs[0]?.bytes ?? [])]).toEqual([...MP3]);
  const sessions = await db.musicSessions.toArray();
  expect(sessions).toHaveLength(1);
  expect(sessions[0]?.title).toBe('Night Drive');
  expect(sessions[0]?.sheet).toEqual(NIGHT_DRIVE);

  // The player and the download are there.
  expect(await screen.findByLabelText('Play Night Drive')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Download' }));
  expect(await screen.findByText(/^Saved Night-Drive-[A-Za-z0-9-]{1,8}\.mp3$/)).toBeInTheDocument();
});

it('a refinement sends the sheet AS IT STANDS ON SCREEN, hand edits included', async () => {
  await configure();
  writerAnswers.push(writes('Started it.', NIGHT_DRIVE));
  renderAnswers.push(song());
  render(<App initialTab="Music" />);
  const user = userEvent.setup();
  await direct(user, 'synthwave night drive');
  await screen.findByLabelText('Play Night Drive');

  // The owner corrects a field by hand, then asks for a change.
  const mood = within(sheetPanel()).getByLabelText('Mood');
  await user.clear(mood);
  await user.type(mood, 'melancholic');
  const darker: SongSheet = { ...NIGHT_DRIVE, mood: 'melancholic', style: 'darkwave' };
  writerAnswers.push(writes('Made the style darker.', darker));
  renderAnswers.push(song());
  await direct(user, 'make it darker');

  expect(await screen.findByText('Made the style darker.')).toBeInTheDocument();
  const sent = (writerPosts[1]?.body.messages as { content: string }[])[1]?.content ?? '';
  expect(sent).toBe(
    `Current sheet:\n${JSON.stringify({ ...NIGHT_DRIVE, mood: 'melancholic' })}\n\nDirection:\nmake it darker`,
  );
  expect(renderPosts[1]?.body.messages).toEqual([{ role: 'user', content: renderPrompt(darker) }]);
  await waitFor(async () => {
    await expect(db.songs.count()).resolves.toBe(2);
  });
  expect(within(sheetPanel()).getByLabelText('Style')).toHaveValue('darkwave');
});

it('a writer that reads NO change renders nothing and says so — no money spent on a question', async () => {
  await configure();
  writerAnswers.push(writes('Started it.', NIGHT_DRIVE));
  renderAnswers.push(song());
  render(<App initialTab="Music" />);
  const user = userEvent.setup();
  await direct(user, 'synthwave night drive');
  await screen.findByLabelText('Play Night Drive');

  writerAnswers.push(writes('It is in a minor key.', null));
  await direct(user, 'what key is it in?');
  expect(await screen.findByText('It is in a minor key.')).toBeInTheDocument();
  expect(screen.getByText(/No change to the song sheet, so nothing was rendered/)).toBeInTheDocument();
  expect(renderPosts).toHaveLength(1);
  await expect(db.songs.count()).resolves.toBe(1);
  // The sheet is unchanged.
  expect(within(sheetPanel()).getByLabelText('Title')).toHaveValue('Night Drive');
});

it('Render renders a hand-filled sheet directly, without the writer', async () => {
  await configure({ songWriterModel: '' });
  renderAnswers.push(song(''));
  render(<App initialTab="Music" />);
  const user = userEvent.setup();
  const panel = await screen.findByRole('region', { name: 'Song sheet' });
  expect(within(panel).getByRole('button', { name: 'Render' })).toBeDisabled();
  await user.type(within(panel).getByLabelText('Style'), 'lofi hip hop');
  await user.click(within(panel).getByRole('checkbox', { name: 'Instrumental (no vocals)' }));
  await user.click(within(panel).getByRole('button', { name: 'Render' }));

  expect(await screen.findByLabelText(/^Play /)).toBeInTheDocument();
  expect(writerPosts).toEqual([]);
  expect(renderPosts[0]?.body.messages).toEqual([
    {
      role: 'user',
      content: 'Style: lofi hip hop\nInstrumental only. No vocals, no sung lyrics, no spoken word.',
    },
  ]);
});

it('a failed render keeps the NEW sheet and shows the failure; Render retries it', async () => {
  await configure();
  writerAnswers.push(writes('Started it.', NIGHT_DRIVE));
  renderAnswers.push(() => jsonResponse({ error: { code: 400, message: 'Lyria refused' } }, 400));
  render(<App initialTab="Music" />);
  const user = userEvent.setup();
  await direct(user, 'synthwave night drive');

  expect((await screen.findAllByText(/Lyria refused/)).length).toBeGreaterThan(0);
  expect(within(sheetPanel()).getByLabelText('Title')).toHaveValue('Night Drive');
  await expect(db.songs.count()).resolves.toBe(0);
  const [session] = await db.musicSessions.toArray();
  expect(session?.sheet).toEqual(NIGHT_DRIVE);
  expect(session?.messages.at(-1)?.error).toMatch(/Lyria refused/);

  renderAnswers.push(song());
  await user.click(within(sheetPanel()).getByRole('button', { name: 'Render' }));
  expect(await screen.findByLabelText('Play Night Drive')).toBeInTheDocument();
  expect(writerPosts).toHaveLength(1);
});

it('a writer answer that fails the schema is a failed turn, never "no change"', async () => {
  await configure();
  writerAnswers.push(() =>
    jsonResponse({
      model: WRITER_MODEL,
      choices: [{ message: { role: 'assistant', content: '{"summary":"ok","sheet":{"title":"x"}}' } }],
    }),
  );
  render(<App initialTab="Music" />);
  await direct(userEvent.setup(), 'anything');
  expect((await screen.findAllByText(/failed validation/)).length).toBeGreaterThan(0);
  expect(renderPosts).toEqual([]);
});

it('every missing or unsuitable pick blocks Send with its reason and sends nothing', async () => {
  await configure({ musicModel: '' });
  const { unmount } = render(<App initialTab="Music" />);
  expect(await screen.findAllByText('No music model selected — pick one in Settings.')).not.toHaveLength(0);
  unmount();

  resetModelCache();
  await configure({ songWriterModel: '' });
  const second = render(<App initialTab="Music" />);
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('Direction'), 'a song');
  expect(screen.getByText('No song-writer model selected — pick one in Settings.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  second.unmount();

  // An image-chat model writes no structured sheet: refused by capability.
  resetModelCache();
  await configure({ songWriterModel: 'google/gemini-2.5-flash-image' });
  render(<App initialTab="Music" />);
  expect(await screen.findByText(/cannot answer with structured JSON/)).toBeInTheDocument();
  expect(writerPosts).toEqual([]);
  expect(renderPosts).toEqual([]);
});

it('Settings lists audio-out models for music and structured text models for the writer', async () => {
  await configure();
  render(<App initialTab="Settings" />);
  const music = await screen.findByRole('listbox', { name: 'Music model options' });
  expect(within(music).getAllByRole('option').map((o) => o.textContent)).toEqual([
    expect.stringContaining(MUSIC_MODEL),
    expect.stringContaining('google/lyria-3-clip-preview'),
    expect.stringContaining('openai/gpt-audio'),
  ]);
  const writer = screen.getByRole('listbox', { name: 'Song-writer model options' });
  expect(within(writer).getAllByRole('option').map((o) => o.textContent)).toEqual([
    expect.stringContaining(WRITER_MODEL),
  ]);
});

it('"Delete take" removes ONE take and keeps the chat; "Delete song" removes the chat and every take after a confirm', async () => {
  await configure();
  writerAnswers.push(writes('Started a synthwave song about a night drive.', NIGHT_DRIVE));
  renderAnswers.push(song(), song());
  render(<App initialTab="Music" />);
  const user = userEvent.setup();
  await direct(user, 'A nostalgic synthwave song about driving at night');
  await screen.findByLabelText('Play Night Drive');
  await user.click(within(sheetPanel()).getByRole('button', { name: 'Render' }));
  await waitFor(() => {
    expect(screen.getAllByLabelText('Play Night Drive')).toHaveLength(2);
  });
  expect(await db.songs.count()).toBe(2);

  // One take: gone from the store, SHOWN as gone in its turn, the chat stays.
  const [firstDelete] = screen.getAllByRole('button', { name: 'Delete take' });
  if (firstDelete === undefined) throw new Error('no delete button');
  await user.click(firstDelete);
  expect(await screen.findByText('The song of this turn is no longer stored.')).toBeInTheDocument();
  expect(await db.songs.count()).toBe(1);
  expect(await db.musicSessions.count()).toBe(1);

  // The whole song asks first; "Keep it" deletes nothing.
  const song_ = screen.getByRole('region', { name: 'Song' });
  await user.click(within(song_).getByRole('button', { name: 'Delete song' }));
  await user.click(within(song_).getByRole('button', { name: 'Keep it' }));
  expect(await db.musicSessions.count()).toBe(1);

  await user.click(within(song_).getByRole('button', { name: 'Delete song' }));
  await user.click(within(song_).getByRole('button', { name: 'Yes, delete' }));
  await waitFor(async () => {
    expect(await db.musicSessions.count()).toBe(0);
  });
  expect(await db.songs.count()).toBe(0);
  expect(await screen.findByText('No songs yet — describe one to start.')).toBeInTheDocument();
  expect(within(song_).getByRole('heading', { name: 'New song' })).toBeInTheDocument();
});
