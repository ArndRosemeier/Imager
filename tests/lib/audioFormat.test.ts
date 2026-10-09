import { expect, it } from 'vitest';

import { audioExtensionFor, sniffAudioFormat } from '@/lib/audioFormat';

const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);

it('names each container by its own signature', () => {
  expect(sniffAudioFormat(ascii('ID3\x04rest')).name).toBe('mp3');
  expect(sniffAudioFormat(new Uint8Array([0xff, 0xfb, 0x90, 0x00])).name).toBe('mp3');
  expect(sniffAudioFormat(ascii('RIFF\x00\x00\x00\x00WAVEfmt ')).name).toBe('wav');
  expect(sniffAudioFormat(ascii('fLaC....')).name).toBe('flac');
  expect(sniffAudioFormat(ascii('OggS....')).name).toBe('ogg');
});

it('anything else is a loud failure, never a guessed type', () => {
  expect(() => sniffAudioFormat(ascii('<html>'))).toThrow(/no format this app recognises/);
  expect(() => sniffAudioFormat(new Uint8Array())).toThrow();
  // RIFF that is not WAVE (e.g. an AVI) is not audio this app stores.
  expect(() => sniffAudioFormat(ascii('RIFF\x00\x00\x00\x00AVI LIST'))).toThrow();
});

it('a stored MIME type maps back to its extension; an unknown one throws', () => {
  expect(audioExtensionFor('audio/mpeg')).toBe('mp3');
  expect(audioExtensionFor('audio/wav')).toBe('wav');
  expect(() => audioExtensionFor('audio/x-unknown')).toThrow();
});
