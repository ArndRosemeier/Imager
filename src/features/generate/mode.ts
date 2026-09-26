/**
 * The generation form's two modes. They live in their own module because the
 * mode is `App` state now (the Gallery tab's "Refine this" sets it across a tab
 * switch, docs/17 row 30), so both `App` and the form need the union without
 * one importing the other's component file.
 */
export const MODES = ['Create', 'Refine'] as const;
export type Mode = (typeof MODES)[number];
