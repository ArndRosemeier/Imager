import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest';

import { saveFile, type SaveRequest } from '@/lib/saveFile';

/**
 * docs/17 row 25 — the save seam's BRANCH MATRIX, pinned by stubbing the one
 * thing that differs between browsers.
 *
 * | `showSaveFilePicker` | outcome            | result                   |
 * |----------------------|--------------------|--------------------------|
 * | present              | written            | `saved` / `file-picker`  |
 * | present              | `AbortError`       | `cancelled` (SILENT)     |
 * | present              | anything else      | THROWS with its reason   |
 * | absent               | anchor download    | `saved` / `anchor`       |
 *
 * `lib.dom` does not declare `showSaveFilePicker` (TS 6.0), so these tests also
 * stand in for the real browser method NAME, SIGNATURE and ASYNC-ness — the
 * lesson from ledger rows 14/15: a double that invents a different shape
 * certifies code the real object would refuse.
 */

const BYTES = new Uint8Array([1, 2, 3, 4]);

interface PickerOptions {
  suggestedName: string;
  types?: { accept: Record<string, string[]> }[];
}

function request(overrides: Partial<SaveRequest> = {}): SaveRequest {
  return {
    fileName: 'imager-images-2026-09-26T08-10-11-123Z.zip',
    mimeType: 'application/zip',
    buildBytes: () => BYTES,
    ...overrides,
  };
}

/** Installs an accepting fake picker; returns the options and what it wrote. */
function installPicker(): { options: PickerOptions[]; blobs: Blob[]; closes: number[] } {
  const options: PickerOptions[] = [];
  const blobs: Blob[] = [];
  const closes: number[] = [];
  const handle = {
    createWritable: () =>
      Promise.resolve({
        write: (data: Blob) => {
          blobs.push(data);
          return Promise.resolve();
        },
        close: () => {
          closes.push(1);
          return Promise.resolve();
        },
      }),
  };
  Object.defineProperty(window, 'showSaveFilePicker', {
    configurable: true,
    value: (received: PickerOptions) => {
      options.push(received);
      return Promise.resolve(handle as unknown as FileSystemFileHandle);
    },
  });
  return { options, blobs, closes };
}

function installRejectingPicker(error: Error): void {
  Object.defineProperty(window, 'showSaveFilePicker', {
    configurable: true,
    value: () => Promise.reject(error),
  });
}

let clickSpy: MockInstance<() => void>;
let createdUrls: Blob[];

/** The bytes of a Blob, as a plain array a matcher can compare. */
async function bytesOf(blob: Blob): Promise<number[]> {
  return Array.from(new Uint8Array(await blob.arrayBuffer()));
}

beforeEach(() => {
  Reflect.deleteProperty(window, 'showSaveFilePicker');
  createdUrls = [];
  URL.createObjectURL = vi.fn((blob: Blob) => {
    createdUrls.push(blob);
    return 'blob:test';
  });
  URL.revokeObjectURL = vi.fn();
  clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, 'showSaveFilePicker');
});

/* ------------------------------------------------------- picker present */

it('a present picker is used: suggested name, MIME type, bytes written and closed', async () => {
  const picker = installPicker();
  const outcome = await saveFile(request());

  expect(outcome).toEqual({ status: 'saved', method: 'file-picker' });
  expect(picker.options).toHaveLength(1);
  expect(picker.options[0]?.suggestedName).toBe('imager-images-2026-09-26T08-10-11-123Z.zip');
  expect(picker.options[0]?.types).toEqual([{ accept: { 'application/zip': ['.zip'] } }]);
  expect(picker.blobs).toHaveLength(1);
  const written = picker.blobs[0];
  if (written === undefined) throw new Error('nothing was written');
  expect(await bytesOf(written)).toEqual(Array.from(BYTES));
  expect(picker.closes).toHaveLength(1);
  // The anchor fallback was NOT taken.
  expect(clickSpy).not.toHaveBeenCalled();
  expect(createdUrls).toEqual([]);
});

it('the bytes are built AFTER the picker returns, so a slow build cannot lose the click', async () => {
  installPicker();
  const buildBytes = vi.fn(() => BYTES);
  await saveFile(request({ buildBytes }));
  expect(buildBytes).toHaveBeenCalledTimes(1);
});

it('a cancelled picker is the owner changing his mind: silent, and nothing was built', async () => {
  installPicker();
  installRejectingPicker(new DOMException('The user aborted a request.', 'AbortError'));
  const buildBytes = vi.fn(() => BYTES);

  await expect(saveFile(request({ buildBytes }))).resolves.toEqual({ status: 'cancelled' });
  expect(buildBytes).not.toHaveBeenCalled();
  expect(clickSpy).not.toHaveBeenCalled();
});

it('`AbortError` is matched by NAME, not by class (a cross-realm object still cancels)', async () => {
  installRejectingPicker(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  await expect(saveFile(request())).resolves.toEqual({ status: 'cancelled' });
});

it('a real failure keeps its own reason — the caller must surface it loudly', async () => {
  installRejectingPicker(new DOMException('Disk is full.', 'NotAllowedError'));
  await expect(saveFile(request())).rejects.toThrow('Disk is full.');
});

/* -------------------------------------------------------- picker absent */

it('an absent picker falls back to the anchor download with the suggested name', async () => {
  const outcome = await saveFile(request());

  expect(outcome).toEqual({ status: 'saved', method: 'anchor' });
  expect(clickSpy).toHaveBeenCalledTimes(1);
  const anchor = clickSpy.mock.contexts[0] as HTMLAnchorElement | undefined;
  expect(anchor?.download).toBe('imager-images-2026-09-26T08-10-11-123Z.zip');
  expect(anchor?.getAttribute('href')).toBe('blob:test');
  expect(anchor?.isConnected).toBe(false); // it exists only to be clicked
  expect(createdUrls).toHaveLength(1);
});

it('no extension in the name means no `types` filter (nothing to constrain)', async () => {
  const picker = installPicker();
  await saveFile(request({ fileName: 'backup' }));
  expect(picker.options[0]?.types).toBeUndefined();
});
