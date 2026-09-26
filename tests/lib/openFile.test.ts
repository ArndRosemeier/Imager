import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest';

import { openFile, type OpenFileRequest } from '@/lib/openFile';

/**
 * docs/17 row 27 — the OPEN seam's BRANCH MATRIX, the mirror of
 * tests/lib/saveFile.test.ts and pinned the same way: by stubbing the one thing
 * that differs between browsers.
 *
 * | `showOpenFilePicker` | outcome                      | result                   |
 * |----------------------|------------------------------|--------------------------|
 * | present              | a file is picked             | `opened` (name + bytes)  |
 * | present              | `AbortError`                 | `cancelled` (SILENT)     |
 * | present              | anything else                | THROWS with its reason   |
 * | absent               | the input's `change` fires   | `opened` (name + bytes)  |
 * | absent               | the input's `cancel` fires   | `cancelled` (SILENT)     |
 *
 * `lib.dom` does not declare `showOpenFilePicker` (TS 6.0 declares the file
 * handle types but no picker method), so these stubs also stand in for the real
 * browser method NAME, SIGNATURE and ASYNC-ness (ledger rows 14/15).
 */

const BYTES = [1, 2, 3, 4, 5, 6];

const REQUEST: OpenFileRequest = {
  description: 'Imager backup',
  extensions: ['.zip'],
  mimeType: 'application/zip',
};

function backupFile(name = 'imager-backup-2026-09-26T08-10-11-123Z.zip'): File {
  return new File([new Uint8Array(BYTES)], name, { type: 'application/zip' });
}

function installPicker(): { pick: () => Promise<FileSystemFileHandle[]> } {
  const pick = (): Promise<FileSystemFileHandle[]> =>
    Promise.resolve([
      {
        getFile: () => Promise.resolve(backupFile()),
      } as unknown as FileSystemFileHandle,
    ]);
  Object.defineProperty(window, 'showOpenFilePicker', { configurable: true, value: pick });
  return { pick };
}

function installRejectingPicker(error: Error): void {
  Object.defineProperty(window, 'showOpenFilePicker', {
    configurable: true,
    value: () => Promise.reject(error),
  });
}

let clickSpy: MockInstance<() => void>;

beforeEach(() => {
  Reflect.deleteProperty(window, 'showOpenFilePicker');
  clickSpy = vi
    .spyOn(HTMLInputElement.prototype, 'click')
    .mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, 'showOpenFilePicker');
});

/** The `<input type="file">` the fallback created (it is removed on settle). */
function lastInput(): HTMLInputElement | undefined {
  return clickSpy.mock.contexts.at(-1) as HTMLInputElement | undefined;
}

/* -------------------------------------------------------- picker present */

it('a present picker is used and the picked file is read whole', async () => {
  installPicker();
  const outcome = await openFile(REQUEST);
  expect(outcome.status).toBe('opened');
  if (outcome.status !== 'opened') return;
  expect(outcome.file.fileName).toBe('imager-backup-2026-09-26T08-10-11-123Z.zip');
  expect(Array.from(outcome.file.bytes)).toEqual(BYTES);
  // The fallback was NOT touched.
  expect(clickSpy).not.toHaveBeenCalled();
});

it('the picker is asked for exactly the requested type, not multiple files', async () => {
  const calls: unknown[] = [];
  Object.defineProperty(window, 'showOpenFilePicker', {
    configurable: true,
    value: (options: unknown) => {
      calls.push(options);
      return Promise.resolve([
        { getFile: () => Promise.resolve(backupFile()) } as unknown as FileSystemFileHandle,
      ]);
    },
  });
  await openFile(REQUEST);
  expect(calls).toEqual([
    {
      multiple: false,
      types: [{ description: 'Imager backup', accept: { 'application/zip': ['.zip'] } }],
    },
  ]);
});

it('a cancelled picker is the owner changing his mind: silent', async () => {
  installRejectingPicker(new DOMException('The user aborted a request.', 'AbortError'));
  await expect(openFile(REQUEST)).resolves.toEqual({ status: 'cancelled' });
});

it('`AbortError` is matched by NAME, not by class (a cross-realm object cancels)', async () => {
  installRejectingPicker(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  await expect(openFile(REQUEST)).resolves.toEqual({ status: 'cancelled' });
});

it('a real failure keeps its own reason — the caller must surface it loudly', async () => {
  installRejectingPicker(new DOMException('Permission denied.', 'NotAllowedError'));
  await expect(openFile(REQUEST)).rejects.toThrow('Permission denied.');
});

it('an empty handle list is a cancel, not a crash', async () => {
  Object.defineProperty(window, 'showOpenFilePicker', {
    configurable: true,
    value: () => Promise.resolve([]),
  });
  await expect(openFile(REQUEST)).resolves.toEqual({ status: 'cancelled' });
});

/* --------------------------------------------------------- picker absent */

it('an absent picker falls back to a hidden file input that accepts the extension', () => {
  void openFile(REQUEST);
  const input = lastInput();
  expect(input).toBeDefined();
  expect(input?.type).toBe('file');
  expect(input?.hidden).toBe(true);
  expect(input?.accept).toBe('.zip,application/zip');
});

it('choosing a file through the input yields its name and bytes', async () => {
  const promise = openFile(REQUEST);
  const input = lastInput();
  if (input === undefined) throw new Error('no input was created');
  Object.defineProperty(input, 'files', { configurable: true, value: [backupFile()] });
  input.dispatchEvent(new Event('change'));

  const outcome = await promise;
  expect(outcome.status).toBe('opened');
  if (outcome.status !== 'opened') return;
  expect(outcome.file.fileName).toBe('imager-backup-2026-09-26T08-10-11-123Z.zip');
  expect(Array.from(outcome.file.bytes)).toEqual(BYTES);
  // The element existed only to be clicked.
  expect(input.isConnected).toBe(false);
});

it('dismissing the input dialog is a SILENT cancel and removes the element', async () => {
  const promise = openFile(REQUEST);
  const input = lastInput();
  if (input === undefined) throw new Error('no input was created');
  input.dispatchEvent(new Event('cancel'));

  await expect(promise).resolves.toEqual({ status: 'cancelled' });
  expect(input.isConnected).toBe(false);
});

it('the input is removed even when reading the chosen file fails (loud reason)', async () => {
  const promise = openFile(REQUEST);
  const input = lastInput();
  if (input === undefined) throw new Error('no input was created');
  const broken = new File([new Uint8Array([1])], 'broken.zip');
  Object.defineProperty(broken, 'arrayBuffer', {
    configurable: true,
    value: () => Promise.reject(new Error('The file could not be read.')),
  });
  Object.defineProperty(input, 'files', { configurable: true, value: [broken] });
  input.dispatchEvent(new Event('change'));

  await expect(promise).rejects.toThrow('The file could not be read.');
  expect(input.isConnected).toBe(false);
});
