/**
 * THE zip dependency seam (AGENTS rule 4): the ONE module that imports
 * `fflate`, so the archive format's compression library cannot fork into a
 * second one.
 *
 * WHY A RE-EXPORT AND NOT TWO IMPORTS: the export seam builds archives
 * (`zipSync`) and the import seam reads them (`unzipSync`). Two files importing
 * `fflate` would be two places that decide how the library is used, and the
 * architecture pin (`tests/architecture/one-export.test.ts`) exists exactly to
 * keep that at one. Neither seam wraps the calls — a reader and a writer are
 * different jobs and both call fflate directly here — the seam only owns WHICH
 * library does the work.
 */
export { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
