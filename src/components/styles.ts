/**
 * The shared control styling in ONE place: the button recipe and the class that
 * makes a keyboard focus ring depend on what the user is doing rather than on
 * which control they hit.
 *
 * Every button in the app goes through `buttonClass`, and every non-button
 * control a keyboard can reach names `focusRing`, so "this control has no
 * visible focus" is a one-line defect here instead of a hunt through nine
 * files. Pinned by tests/architecture/design-system.test.ts.
 *
 * No components live in this file on purpose: a module that exports both
 * components and helpers defeats React Fast Refresh's boundary.
 */

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'ghost'
  | 'danger'
  | 'invert'
  | 'dangerInvert';

/** The pointer feedback that pairs with each role. */
const HOVER: Record<ButtonVariant, string> = {
  primary: 'hover:btn-primary-hover',
  secondary: 'hover:btn-secondary-hover',
  ghost: 'hover:btn-ghost-hover',
  danger: 'hover:btn-danger-hover',
  invert: 'hover:btn-invert-hover',
  dangerInvert: 'hover:btn-danger-invert-hover',
};

const ROLE: Record<ButtonVariant, string> = {
  primary: 'btn-primary',
  secondary: 'btn-secondary',
  ghost: 'btn-ghost',
  danger: 'btn-danger',
  invert: 'btn-invert',
  dangerInvert: 'btn-danger-invert',
};

/**
 * The focus treatment. It is per-variant because the lightbox's controls sit on
 * a dark photo rather than on a theme surface, so their ring is the on-photo
 * one; every other role uses the theme's `--focus`.
 */
const FOCUS: Record<ButtonVariant, string> = {
  primary: 'focus-ring focus-visible:focus-ring-on',
  secondary: 'focus-ring focus-visible:focus-ring-on',
  ghost: 'focus-ring focus-visible:focus-ring-on',
  danger: 'focus-ring focus-visible:focus-ring-on',
  invert: 'focus-ring-photo focus-visible:focus-ring-photo-on',
  dangerInvert: 'focus-ring-photo focus-visible:focus-ring-photo-on',
};

/**
 * The class list for a button of a given role. Exactly ONE `primary` per view
 * is the rule; the roles exist so a second loud button is a visible mistake.
 */
export function buttonClass(variant: ButtonVariant, extra = ''): string {
  return [
    ROLE[variant],
    HOVER[variant],
    FOCUS[variant],
    // A disabled control is still legible: the label keeps its ink colour and
    // the cursor says why nothing happens.
    'disabled:cursor-not-allowed disabled:opacity-50',
    extra,
  ]
    .filter((part) => part !== '')
    .join(' ');
}

/** The visible keyboard-focus treatment for a control that is NOT a `field`. */
export const focusRing = 'focus-ring focus-visible:focus-ring-on';
