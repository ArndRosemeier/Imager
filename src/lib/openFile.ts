/**
 * THE open seam (docs/17 row 27): the ONE place Imager takes a file IN from the
 * owner's disk. It is the mirror of `src/lib/saveFile.ts` and deliberately sits
 * beside it — same branch matrix, same cancel-is-silent rule, same widened
 * structural read of a picker method `lib.dom` does not declare (TS 6.0 has
 * `showOpenFilePicker`? it has the FILE HANDLE types but no picker method, the
 * exact situation `saveFile` documents).
 *
 * THE BRANCH MATRIX (pinned by tests/lib/openFile.test.ts):
 *
 * | `showOpenFilePicker` | outcome of the call          | result                  |
 * |----------------------|------------------------------|-------------------------|
 * | present              | owner picks a file           | `{opened, name, bytes}` |
 * | present              | owner cancels (`AbortError`) | `{cancelled}` (SILENT)  |
 * | present              | real failure                 | THROWS (loud, rule 1/2) |
 * | absent               | hidden `<input type=file>`   | `{opened, name, bytes}` |
 * | absent               | the file dialog is dismissed | `{cancelled}` (SILENT)  |
 *
 * The cancel case must stay SILENT: the owner changed his mind, so a toast
 * would be the app arguing with him. The picker's abort is distinguished by
 * NAME (`AbortError`), read structurally because a `DOMException` from another
 * realm is not `instanceof` ours. Everything else propagates with its real
 * reason and the caller surfaces it through the toast seam (rule 2).
 *
 * WHY THE WHOLE FILE IS READ HERE: an import needs every byte of the archive
 * (the manifest AND each image's bytes to verify its hash), so there is nothing
 * to stream and no callback to defer. A picked file is read once, into memory,
 * and handed on as one `Uint8Array`.
 *
 * THE ABSENT-PICKER FALLBACK AND ITS HONEST LIMIT: a hidden
 * `<input type="file">` is appended, clicked and removed. Its `change` event
 * carries the choice; its `cancel` event (Chrome 113+, Firefox 91+, Safari
 * 16.4+) carries the dismissal. On a browser with NEITHER the picker NOR the
 * input `cancel` event, a dismissed dialog leaves this promise pending — the
 * caller keeps waiting and nothing is imported. That is the honest failure: no
 * file was opened, and inventing a "cancelled" answer the browser never gave
 * would be a silent fallback (rule 1).
 */

/** What the owner is being asked for. */
export interface OpenFileRequest {
  /** The picker's own description, e.g. `Imager backup`. */
  description: string;
  /** The allowed file-name extensions, e.g. `['.zip']`. */
  extensions: readonly string[];
  /** The MIME type those extensions carry, e.g. `application/zip`. */
  mimeType: string;
}

/** One chosen file, read whole. */
export interface OpenedFile {
  /** The name the file had on disk (shown to the owner, never trusted as a path). */
  fileName: string;
  /** The entire contents. */
  bytes: Uint8Array<ArrayBuffer>;
}

/**
 * What happened. `cancelled` is an OUTCOME, not an error: the caller must not
 * toast, throw or report anything for it.
 */
export type OpenOutcome = { status: 'opened'; file: OpenedFile } | { status: 'cancelled' };

/** The picker call shape this seam needs, read structurally (see header). */
interface OpenTypeDescription {
  description?: string;
  accept: Record<string, string[]>;
}

interface OpenFilePickerWindow {
  showOpenFilePicker?: (options: {
    multiple?: boolean;
    types?: OpenTypeDescription[];
  }) => Promise<FileSystemFileHandle[]>;
}

/** The `accept` entry for the requested extensions. */
function openTypeFor(request: OpenFileRequest): OpenTypeDescription | undefined {
  if (request.extensions.length === 0) return undefined;
  return {
    description: request.description,
    accept: { [request.mimeType]: [...request.extensions] },
  };
}

/** True for the owner-cancelled case, whatever realm the DOMException came
 * from: the NAME is the contract (the save seam's rule, shared verbatim). */
function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

/** Read a picked `File` whole. The read failure keeps its own reason. */
async function readFile(file: File): Promise<OpenedFile> {
  return { fileName: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
}

/**
 * The no-picker fallback: a hidden `<input type="file">`. It exists only to be
 * clicked and is removed as soon as the dialog answers, so a second open starts
 * from a clean element rather than reusing one with a stale `files` list.
 */
function inputOpen(request: OpenFileRequest): Promise<OpenOutcome> {
  return new Promise<OpenOutcome>((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.hidden = true;
    input.accept = [...request.extensions, request.mimeType].join(',');

    const cleanup = (): void => {
      input.removeEventListener('change', onChange);
      input.removeEventListener('cancel', onCancel);
      input.remove();
    };
    const settle = (outcome: OpenOutcome): void => {
      cleanup();
      resolve(outcome);
    };
    const onChange = (): void => {
      const file = input.files?.[0];
      if (file === undefined) {
        settle({ status: 'cancelled' });
        return;
      }
      readFile(file).then(
        (opened) => {
          settle({ status: 'opened', file: opened });
        },
        (error: unknown) => {
          cleanup();
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    };
    const onCancel = (): void => {
      settle({ status: 'cancelled' });
    };

    input.addEventListener('change', onChange);
    input.addEventListener('cancel', onCancel);
    document.body.append(input);
    input.click();
  });
}

/**
 * Ask the owner for a file and read it. Resolves with the bytes or with
 * `cancelled`; THROWS on a real failure (never on a cancel).
 */
export async function openFile(request: OpenFileRequest): Promise<OpenOutcome> {
  const picker = (window as unknown as OpenFilePickerWindow).showOpenFilePicker;
  if (picker === undefined) return inputOpen(request);

  const type = openTypeFor(request);
  let handles: FileSystemFileHandle[];
  try {
    handles = await picker({
      multiple: false,
      ...(type === undefined ? {} : { types: [type] }),
    });
  } catch (error: unknown) {
    if (isAbortError(error)) return { status: 'cancelled' };
    throw error;
  }
  const handle = handles[0];
  if (handle === undefined) return { status: 'cancelled' };
  return { status: 'opened', file: await readFile(await handle.getFile()) };
}
