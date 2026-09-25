import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

import { sourceFiles } from '../helpers';

/**
 * SOURCE-LEVEL pins for docs/17 row 17. jsdom computes no layout, so the
 * full-viewport claim cannot be measured here (it IS measured in a real
 * browser — see the ledger row); what CAN be pinned is the shape that made the
 * old cap possible.
 */
const GALLERY = 'src/features/gallery/Gallery.tsx';
const galleryCode = readFileSync(GALLERY, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');

it('the full image view fills the viewport instead of capping the image at 70vh', () => {
  // The owner's complaint: `max-h-[70vh]` on the image inside a fixed box.
  expect(galleryCode).not.toContain('max-h-[70vh]');
  // The dialog is a full-viewport flex column ...
  expect(galleryCode).toContain('fixed inset-0');
  expect(galleryCode).toContain('flex flex-col');
  // ... whose image area is the only growing part (`min-h-0` lets it shrink
  // below the image's intrinsic size) ...
  expect(galleryCode).toContain('min-h-0');
  expect(galleryCode).toContain('flex-1');
  // ... and the image is bounded by that area in BOTH directions.
  expect(galleryCode).toContain('max-h-full');
  expect(galleryCode).toContain('max-w-full');
  expect(galleryCode).toContain('object-contain');
});

it('the dialog keeps its accessible name and the metadata survives the bigger image', () => {
  expect(galleryCode).toContain('role="dialog"');
  expect(galleryCode).toContain('aria-label="Image details"');
  // Prompt, model and the created/size/cost line are still rendered.
  expect(galleryCode).toContain('{image.prompt}');
  expect(galleryCode).toContain('{image.model}');
  expect(galleryCode).toContain('run cost');
});

// Rule 4 / docs/17 row 17: the gallery's "Chat with this image" folds into the
// composer's EXISTING staged-attachment state (row 16). A second `StoredImage[]`
// staging state anywhere in src/ would be a second attachment mechanism.
it('exactly one staged chat attachment state exists in src/', () => {
  const hits = sourceFiles('src').filter((f) =>
    readFileSync(f, 'utf8').includes('useState<StoredImage[]>'),
  );
  expect(hits).toEqual(['src/features/chat/ChatArea.tsx']);
});
