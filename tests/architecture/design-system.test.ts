import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

import { WIDE_QUERY, useMinWidth } from '@/lib/media';

import { sourceFiles } from '../helpers';


/**
 * THE design-system pins for the beauty pass (docs/17 row 20).
 *
 * These are source/CSS-level pins on purpose: jsdom computes no colour and no
 * font, so "the app has a type scale", "no component invents a raw colour",
 * "every button role carries focus + hover + disabled" and "the accent keeps a
 * legible label" can only be stated where those values live. The real-browser
 * evidence is in the ledger row; these are the regressions it cannot catch on
 * the next commit.
 */

const CSS = readFileSync('src/index.css', 'utf8');
const code = (path: string): string =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

const THEME_SOURCE = sourceFiles('src');

/* ------------------------------------------------------------------ types */

it('every text size comes from the named type scale, never an ad-hoc step', () => {
  // `text-sm`, `text-2xl`, … are the drift this replaces: the same idea written
  // differently in nine files. The scale is title/heading/body/label/caption.
  const adHoc = /(?<![-\w])text-(?:xs|sm|base|lg|xl|2xl|3xl|4xl)\b/;
  const offenders = THEME_SOURCE.filter((file) => adHoc.test(code(file)));
  expect(offenders).toEqual([]);
  for (const step of [
    '--text-title',
    '--text-heading',
    '--text-body',
    '--text-label',
    '--text-caption',
  ]) {
    expect(CSS).toContain(step);
  }
});

it('Inter is self-hosted through the theme seam — no external font request', () => {
  expect(readFileSync('src/main.tsx', 'utf8')).toContain("import '@fontsource-variable/inter'");
  // The stack is a theme variable, so `font-sans` (and the body default) are
  // the same face; the monospace stack is kept for ids and keys only.
  expect(CSS).toContain('--font-sans');
  expect(CSS).toContain("'Inter Variable'");
  expect(CSS).toContain('--font-mono');
  // "No external font CDN": nothing in src/ fetches from a font host.
  for (const file of THEME_SOURCE) {
    const text = readFileSync(file, 'utf8');
    expect(text).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    expect(text).not.toMatch(/@import\s+url\(/);
  }
});

/* --------------------------------------------------------------- colours */

it('the accent is indigo/violet in BOTH themes', () => {
  const light = CSS.slice(CSS.indexOf(':root {'), CSS.indexOf('.dark {'));
  const dark = CSS.slice(CSS.indexOf('.dark {'));
  expect(light).toMatch(/--accent:\s*#4f46e5/);
  expect(dark).toMatch(/--accent:\s*#818cf8/);
  expect(light).toMatch(/--accent-soft:\s*#eef2ff/);
  expect(dark).toMatch(/--accent-soft:\s*#1e1b4b/);
});

it('no component paints a raw colour — every surface goes through a role token', () => {
  /*
   * Two explicit lists, because the honest distinction is not "hyphen or not":
   *
   *  * ROLE PREFIXES — the semantic utilities of the theme seam. A token from
   *    the Tailwind palette (`bg-blue-500`, `text-gray-600`, `border-amber-400`)
   *    never starts with one of these, which is exactly the point.
   *  * STRUCTURAL — utilities that only look like colours: layout
   *    (`text-center`, `text-left`), axis borders (`border-t`, `border-b`) and
   *    the lightbox, which is a dark photo surface in BOTH themes.
   */
  const rolePrefixes = [
    'bg-canvas',
    'bg-surface',
    'bg-subtle',
    'bg-accent',
    'bg-danger',
    'bg-warn',
    'bg-overlay',
    'text-ink',
    'text-muted',
    'text-on-',
    'text-ok',
    'text-danger',
    'border-strong',
    'border-accent',
    'border-danger',
    'border-warn',
  ];
  const structural = new Set([
    // The lightbox backdrop: a dark photo surface, identical in both themes.
    'bg-black/85',
    'text-white',
    'text-center',
    'text-left',
    'text-right',
    'border-t',
    'border-b',
    'border-l',
    'border-r',
    'border-white',
  ]);
  const pattern =
    /(?<![\w-])(?:bg|text|border)-([a-z]+)(?:-([a-z]+))?(?:-(\d{2,3}))?(?:\/\d+)?/g;
  const offenders: string[] = [];
  for (const file of THEME_SOURCE) {
    for (const match of code(file).matchAll(pattern)) {
      const utility = match[0];
      if (rolePrefixes.some((prefix) => utility.startsWith(prefix))) continue;
      if (structural.has(utility)) continue;
      // `text-body`, `text-title`… are scale utilities, not colours.
      if (/^text-(title|heading|body|label|caption)$/.test(utility)) continue;
      offenders.push(`${file}: ${utility}`);
    }
  }
  expect(offenders).toEqual([]);
});

/* -------------------------------------------------------------- controls */

it('every button role carries hover, a visible focus ring and a disabled state', async () => {
  const { buttonClass } = await import('@/components/styles');
  const variants = ['primary', 'secondary', 'ghost', 'danger', 'invert', 'dangerInvert'] as const;
  const focusCount = new Map<string, number>();
  for (const variant of variants) {
    const cls = buttonClass(variant);
    expect(cls).toMatch(/hover:/);
    expect(cls).toMatch(/focus-visible:focus-ring-(on|photo-on)/);
    expect(cls).toContain('disabled:');
    expect(cls).toContain(`btn-${variant === 'dangerInvert' ? 'danger-invert' : variant}`);
    for (const token of cls.split(' ')) {
      if (token.startsWith('focus-ring')) {
        focusCount.set(token, (focusCount.get(token) ?? 0) + 1);
      }
    }
  }
  // The focus treatment is defined ONCE in CSS, not re-invented per variant.
  expect(focusCount.size).toBe(2);
});

it('a raw outline-none without a ring is a defect', () => {
  const offenders = THEME_SOURCE.filter((file) => {
    const text = code(file);
    return text.includes('outline-none') && !text.includes('focus-ring');
  });
  expect(offenders).toEqual([]);
});

/* -------------------------------------------------------------- contrast */

/** WCAG relative luminance. */
function luminance(hex: string): number {
  const value = hex.replace('#', '');
  const channels = [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16) / 255);
  const linear = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

/** Every semantic token of one theme block, so a re-colour cannot slip past. */
function tokens(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)) {
    out[(match[1] ?? '').replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = match[2] ?? '';
  }
  return out;
}

const LIGHT = tokens(CSS.slice(CSS.indexOf(':root {'), CSS.indexOf('.dark {')));
const DARK = tokens(CSS.slice(CSS.indexOf('.dark {')));

it('the measured contrast ratios keep every floor (accent label >= 4.5:1)', () => {
  for (const [name, theme] of [
    ['light', LIGHT],
    ['dark', DARK],
  ] as const) {
    const accent = theme.accent ?? '';
    const accentStrong = theme.accentStrong ?? '';
    const canvas = theme.canvas ?? '';
    const surface = theme.surface ?? '';
    const ink = theme.ink ?? '';
    const muted = theme.inkMuted ?? '';
    const onAccent = theme.onAccent ?? '';
    // The floors are the numbers measured before the beauty pass (docs/17 row
    // 19): a re-colour may improve them, never regress them.
    expect(contrast(onAccent, accent), `${name} accent label`).toBeGreaterThanOrEqual(4.5);
    expect(contrast(ink, canvas), `${name} body on canvas`).toBeGreaterThanOrEqual(15);
    expect(contrast(ink, surface), `${name} body on surface`).toBeGreaterThanOrEqual(13);
    expect(contrast(muted, canvas), `${name} muted on canvas`).toBeGreaterThanOrEqual(6.3);
    expect(contrast(muted, surface), `${name} muted on surface`).toBeGreaterThanOrEqual(5.9);
    expect(contrast(onAccent, accentStrong), `${name} accent label on hover`).toBeGreaterThanOrEqual(
      4.5,
    );
  }
});

/* ------------------------------------------------------------- structure */

it('the side rail becomes persistent at exactly the breakpoint the code queries', () => {
  expect(WIDE_QUERY).toBe('(min-width: 1024px)');
  // The CSS half of the same decision, in one place.
  expect(CSS).toContain('@media (min-width: 1024px)');
  expect(CSS).toContain('@media (max-width: 1023.98px)');
  expect(typeof useMinWidth).toBe('function');
});

it('there is exactly one source of button styling', () => {
  const withRawButton = THEME_SOURCE.filter((file) =>
    /className="[^"]*\bbtn-(primary|secondary|danger)\b/.test(code(file)),
  );
  // Call sites name a ROLE through `buttonClass`, so none of them hand-write a
  // button recipe (the segmented items are the one deliberate exception).
  expect(withRawButton).toEqual([]);
});
