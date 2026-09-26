import { useId, useMemo, useState } from 'react';

import { focusRing } from '@/components/styles';
import {
  acceptsImageInput,
  canRefineViaChat,
  type OpenRouterModel,
} from '@/llm/models';

interface Props {
  label: string;
  models: readonly OpenRouterModel[];
  selectedId: string;
  onSelect: (id: string) => void;
}

/** Prices are USD-per-unit decimal strings; show them as given, per unit. */
function priceSummary(model: OpenRouterModel): string {
  const parts: string[] = [];
  for (const key of ['prompt', 'completion', 'image', 'image_output'] as const) {
    const value = model.pricing[key];
    if (typeof value === 'string')
      parts.push(`${key} ${value === '-1' ? 'variable' : `$${value}`}`);
  }
  return parts.length === 0 ? 'price n/a' : parts.join(' · ');
}

function badges(model: OpenRouterModel): string[] {
  const out = ['image out'];
  if (acceptsImageInput(model)) out.push('image in');
  if (canRefineViaChat(model))
    out.push('chat refine');
  return out;
}

/** Searchable single-select model list. Empty selection is a visible state. */
export function ModelPicker({ label, models, selectedId, onSelect }: Props): React.JSX.Element {
  const [query, setQuery] = useState('');
  const searchId = useId();
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q === ''
      ? models
      : models.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
  }, [models, query]);
  const selected = models.find((m) => m.id === selectedId);

  return (
    <section aria-label={label} className="card p-3">
      <h3 className="text-heading text-ink">{label}</h3>
      <p className="text-caption text-muted" data-testid={`${label}-selection`}>
        {selectedId === ''
          ? 'No model selected'
          : selected === undefined
            ? `Selected: ${selectedId} (not in the current list)`
            : `Selected: ${selected.name} (${selected.id})`}
      </p>
      <label htmlFor={searchId} className="mt-3 block text-label text-ink">
        Search {label}
      </label>
      <input
        id={searchId}
        type="search"
        className="field focus-visible:field-focus hover:field-hover mt-1"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
        }}
      />
      {filtered.length === 0 ? (
        <p className="mt-2 rounded-lg border border-strong bg-subtle px-3 py-4 text-center text-body text-muted">
          No models match “{query}”.
        </p>
      ) : (
        <ul
          className="mt-2 flex max-h-64 flex-col gap-1 overflow-auto pr-1"
          role="listbox"
          aria-label={`${label} options`}
        >
          {filtered.map((m) => (
            <li key={m.id} role="option" aria-selected={m.id === selectedId}>
              <button
                type="button"
                className={`w-full rounded-lg px-2 py-1.5 text-left ${focusRing} ${
                  m.id === selectedId
                    ? 'bg-accent-soft ring-1 ring-accent/40'
                    : 'hover:bg-subtle'
                }`}
                onClick={() => {
                  onSelect(m.id);
                }}
              >
                <span className="text-body font-medium text-ink">{m.name}</span>{' '}
                <span className="font-mono text-caption text-muted">{m.id}</span>
                <span className="block text-caption text-muted">{priceSummary(m)}</span>
                <span className="flex flex-wrap gap-1 pt-0.5">
                  {badges(m).map((b) => (
                    <span key={b} className="chip">
                      {b}
                    </span>
                  ))}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
