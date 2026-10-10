import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { App } from '@/App';
import { db } from '@/db/db';
import { updateSettings } from '@/db/settingsRepo';
import { listTagsInUse } from '@/db/tagRepo';
import { resetModelCache } from '@/llm/models';
import { jsonResponse } from '../helpers';

/**
 * The Sounds and Voice tabs end to end (docs/17 row 60): text → `POST
 * /audio/speech` → a stored, playable, taggable, downloadable, deletable clip,
 * kept on its own tab.
 */
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 1]);
const MODELS = {
  data: [
    {
      id: 'elevenlabs/eleven-v4',
      name: 'ElevenLabs: Eleven v4',
      architecture: { input_modalities: ['text'], output_modalities: ['speech'] },
      supported_parameters: [],
      pricing: { prompt: '0.00004', completion: '0' },
      supported_voices: ['george', 'sarah'],
    },
    {
      id: 'bytedance-seed/seed-audio-1-0',
      name: 'ByteDance Seed: Seed Audio 1.0',
      architecture: { input_modalities: ['text'], output_modalities: ['speech'] },
      supported_parameters: [],
      pricing: { prompt: '0', completion: '0.0025' },
    },
  ],
};

let speechBodies: Record<string, unknown>[] = [];

beforeEach(async () => {
  resetModelCache();
  await Promise.all([db.settings.clear(), db.clips.clear()]);
  speechBodies = [];
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    if (url.includes('/models')) return Promise.resolve(jsonResponse(MODELS));
    if (url.endsWith('/audio/speech')) {
      speechBodies.push(JSON.parse(typeof init?.body === 'string' ? init.body : '') as Record<string, unknown>);
      return Promise.resolve(new Response(MP3, { headers: { 'X-Generation-Id': 'gen-1' } }));
    }
    return Promise.reject(new Error(`unexpected ${url}`));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it('the Voice tab speaks text with the picked voice and keeps the clip', async () => {
  await updateSettings({ openRouterApiKey: 'sk', voiceModel: 'elevenlabs/eleven-v4' });
  render(<App initialTab="Voice" />);
  const user = userEvent.setup();

  await user.type(await screen.findByLabelText('Text to speak'), 'Welcome, traveller');
  await user.selectOptions(screen.getByLabelText('Voice'), 'sarah');
  await user.type(screen.getByLabelText('How to say it (optional)'), 'warmly');
  await user.click(screen.getByRole('button', { name: 'Speak' }));

  const list = await screen.findByRole('region', { name: 'Voice clips' });
  await within(list).findByText('Welcome, traveller');
  expect(speechBodies).toEqual([
    {
      model: 'elevenlabs/eleven-v4',
      input: 'Welcome, traveller',
      response_format: 'mp3',
      voice: 'sarah',
      instructions: 'warmly',
    },
  ]);
  expect(within(list).getByLabelText('Play: Welcome, traveller')).toBeInTheDocument();
  const stored = await db.clips.toArray();
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({ kind: 'voice', mimeType: 'audio/mpeg', generationId: 'gen-1' });

  // Tagging a clip adds to the ONE shared vocabulary.
  await user.type(within(list).getByRole('textbox', { name: /tag/i }), 'Narrator{Enter}');
  await waitFor(async () => {
    expect(await listTagsInUse()).toEqual(['narrator']);
  });

  // Delete asks first, then removes the row.
  await user.click(within(list).getByRole('button', { name: 'Delete' }));
  await user.click(within(list).getByRole('button', { name: 'Yes, delete' }));
  await waitFor(async () => {
    expect(await db.clips.count()).toBe(0);
  });
});

it('the Sounds tab sends only the description, and its clips stay off the Voice tab', async () => {
  await updateSettings({
    openRouterApiKey: 'sk',
    soundModel: 'bytedance-seed/seed-audio-1-0',
    voiceModel: 'elevenlabs/eleven-v4',
  });
  render(<App initialTab="Sounds" />);
  const user = userEvent.setup();

  expect(await screen.findByText(/no dedicated sound-effects model/)).toBeInTheDocument();
  expect(screen.queryByLabelText('Voice')).toBeNull();
  await user.type(screen.getByLabelText('Describe the sound'), 'A door creaks');
  await user.click(screen.getByRole('button', { name: 'Make sound' }));
  await within(await screen.findByRole('region', { name: 'Sounds' })).findByText('A door creaks');
  expect(speechBodies).toEqual([
    { model: 'bytedance-seed/seed-audio-1-0', input: 'A door creaks', response_format: 'mp3' },
  ]);

  await user.click(screen.getByRole('tab', { name: 'Voice' }));
  expect(await screen.findByText('No voice clips yet.')).toBeInTheDocument();
  expect(screen.queryByText('A door creaks')).toBeNull();
});

it('no model picked is a visible blocker, never a substituted model', async () => {
  await updateSettings({ openRouterApiKey: 'sk' });
  render(<App initialTab="Voice" />);
  expect(await screen.findByText('No voice model selected — pick one in Settings.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Speak' })).toBeDisabled();
});
