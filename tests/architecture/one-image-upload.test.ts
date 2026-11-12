import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

import { sourceFiles } from '../helpers';

/**
 * docs/17 row 63: an image FILE from the device becomes a gallery row in ONE
 * place, `saveImageFile`. Refine, chat and the video start/end image all call
 * it; a second `File` → `saveUploadedImage` copy goes red here.
 */
const filesContaining = (needle: string): string[] =>
  sourceFiles('src').filter((f) => readFileSync(f, 'utf8').includes(needle));

it('ONE place reads an uploaded image file into the gallery', () => {
  expect(filesContaining('mimeType: file.type')).toEqual(['src/db/imageRepo.ts']);
  expect(filesContaining('saveImageFile(').sort()).toEqual([
    'src/db/imageRepo.ts',
    'src/features/chat/useStagedAttachment.ts',
    'src/features/gallery/useImageImport.ts',
    'src/features/refine/RefinePanel.tsx',
    'src/features/videos/VideosArea.tsx',
  ]);
});

it('ONE place takes a pasted image: the gallery import hook (docs/17 row 65)', () => {
  expect(filesContaining("addEventListener('paste'")).toEqual([
    'src/features/gallery/useImageImport.ts',
  ]);
});
