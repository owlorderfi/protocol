import { useEffect, useState, type ReactNode } from 'react';

/**
 * Minimal tab strip + content area. Active tab persists in localStorage so
 * page refresh doesn't drop the user back on the first tab.
 *
 * Use it as the wrapper for the right column of the layout — Create Order,
 * Wrap/Unwrap, DCA, etc. Disabled tabs render but can't be selected; useful
 * for "coming soon" placeholders that signal the product direction.
 */
export interface TabSpec {
  id: string;
  label: string;
  content: ReactNode;
  disabled?: boolean;
  badge?: string; // e.g. "Soon" for upcoming features
}

interface Props {
  tabs: TabSpec[];
  /** Used as the localStorage key — pick a stable name per usage site. */
  storageKey: string;
  /** Optional default tab id; falls back to the first enabled tab. */
  defaultTabId?: string;
  /**
   * Fires when the active tab changes. Lets the parent filter unrelated
   * panels by the current selection — e.g., scope an orders list to the
   * tab the user is reading.
   */
  onActiveChange?: (id: string) => void;
}

export function Tabs({ tabs, storageKey, defaultTabId, onActiveChange }: Props) {
  const firstEnabled = tabs.find((t) => !t.disabled)?.id ?? tabs[0]?.id ?? '';
  const initial = defaultTabId ?? firstEnabled;

  const [activeId, setActiveId] = useState<string>(() => {
    const stored = typeof window !== 'undefined' ? localStorage.getItem(storageKey) : null;
    if (stored && tabs.some((t) => t.id === stored && !t.disabled)) return stored;
    return initial;
  });

  useEffect(() => {
    if (typeof window !== 'undefined') localStorage.setItem(storageKey, activeId);
    onActiveChange?.(activeId);
  }, [activeId, storageKey, onActiveChange]);

  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];

  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="Section" className="flex gap-1 rounded-xl border border-slate-800 bg-slate-900/40 p-1">
        {tabs.map((t) => {
          const isActive = t.id === activeId;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-controls={`tabpanel-${t.id}`}
              disabled={t.disabled}
              onClick={() => !t.disabled && setActiveId(t.id)}
              className={[
                'flex-1 rounded-lg px-3 py-1.5 text-xs font-medium uppercase tracking-wider transition',
                isActive
                  ? 'bg-slate-800 text-slate-100 shadow-sm'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50',
                t.disabled ? 'cursor-not-allowed opacity-40 hover:bg-transparent hover:text-slate-400' : '',
              ].join(' ')}
            >
              <span>{t.label}</span>
              {t.badge && (
                <span className="ml-1.5 rounded-full bg-slate-700/60 px-1.5 py-0.5 text-xs tracking-normal text-slate-300">
                  {t.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" id={`tabpanel-${active.id}`} aria-labelledby={active.id}>
        {active.content}
      </div>
    </div>
  );
}
