import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

import { sourceFiles } from '../helpers';

/**
 * The video slice's "exactly one" pins (docs/17 row 56, AGENTS rule 4 made
 * mechanical): each goes red when a second implementation appears in src/.
 */
const filesContaining = (needle: string): string[] =>
  sourceFiles('src').filter((f) => readFileSync(f, 'utf8').includes(needle));

it('ONE video seam talks to /videos', () => {
  expect(filesContaining("'/videos")).toEqual(['src/llm/video.ts']);
  expect(filesContaining('`/videos/')).toEqual(['src/llm/video.ts']);
});

it('ONE video-format decision: bytes are typed by their signature in one module', () => {
  expect(filesContaining('function sniffVideoFormat')).toEqual(['src/lib/videoFormat.ts']);
  expect(filesContaining('sniffVideoFormat(')).toEqual(['src/lib/videoFormat.ts', 'src/llm/video.ts']);
});

it('ONE "settings, then the model list" loader for the chat, music and video tabs', () => {
  expect(filesContaining('function useModelList')).toEqual(['src/features/settings/useModelList.ts']);
  expect(filesContaining('useModelList(').sort()).toEqual([
    'src/features/chat/useChat.ts',
    'src/features/videos/useVideos.ts',
  ]);
  // No feature hook reads the settings and a list on its own any more.
  expect(filesContaining('listModels(settings.openRouterApiKey)')).toEqual([]);
});

it('ONE place a job is polled and turned into a video', () => {
  expect(filesContaining('pollVideo(').sort()).toEqual([
    'src/features/videos/runVideo.ts',
    'src/llm/video.ts',
  ]);
  expect(filesContaining('completeVideoJob(').sort()).toEqual([
    'src/db/videoRepo.ts',
    'src/features/videos/runVideo.ts',
  ]);
});
