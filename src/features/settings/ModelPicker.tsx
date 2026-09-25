import { useId, useMemo, useState } from 'react';

import {
  acceptsImageInput,
  canRefineViaChat,
  producesTextToo,
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
    out.push(producesTextToo(model) ? 'chat refine (text+image)' : 'chat refine (image only)');
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
    <section aria-label={label} className="rounded border border-gray-300 p-3">
      <h3 className="font-semibold">{label}</h3>
      <p className="text-sm" data-testid={`${label}-selection`}>
        {selectedId === ''
          ? 'No model selected'
          : selected === undefined
            ? `Selected: ${selectedId} (not in the current list)`
            : `Selected: ${selected.name} (${selected.id})`}
      </p>
      <label htmlFor={searchId} className="mt-2 block text-sm">
        Search {label}
      </label>
      <input
        id={searchId}
        type="search"
        className="w-full rounded border px-2 py-1"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
        }}
      />
      <ul className="mt-2 max-h-64 overflow-auto" role="listbox" aria-label={`${label} options`}>
        {filtered.map((m) => (
          <li key={m.id} role="option" aria-selected={m.id === selectedId}>
            <button
              type="button"
              className={`w-full rounded px-2 py-1 text-left hover:bg-gray-100 ${m.id === selectedId ? 'bg-blue-50' : ''}`}
              onClick={() => {
                onSelect(m.id);
              }}
            >
              <span className="font-medium">{m.name}</span>{' '}
              <span className="font-mono text-xs text-gray-600">{m.id}</span>
              <span className="block text-xs text-gray-600">{priceSummary(m)}</span>
              <span className="flex gap-1">
                {badges(m).map((b) => (
                  <span key={b} className="rounded bg-gray-200 px-1 text-xs">
                    {b}
                  </span>
                ))}
              </span>
            </button>
          </li>
        ))}
        {filtered.length === 0 && <li className="text-sm text-gray-600">No models match.</li>}
      </ul>
    </section>
  );
}
