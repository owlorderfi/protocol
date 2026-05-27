import { useEffect, useState } from 'react';

/**
 * Drop-in replacement for `useState` that persists the form state to
 * `sessionStorage` under a caller-supplied key. Restored on mount, saved
 * on every change.
 *
 * Why: switching tabs in the create-orders UI (Limit / DCA / TWAP)
 * unmounts the form and resets useState — users lost their inputs
 * mid-fill every time they peeked at another tab. `sessionStorage`
 * keeps the values around for the lifetime of the browser tab while
 * still clearing when the user closes it (no permanent litter).
 *
 * Persistence is shallow-merge with `defaults` so adding a new field
 * to the form schema in a future release Just Works: persisted blobs
 * from older sessions get the new default for fields they don't carry,
 * rather than rendering `undefined` for them.
 *
 * Storage failures (private mode, quota exceeded) are silently swallowed
 * and the hook degrades to plain in-memory state.
 *
 * Per-chain keys are the caller's responsibility — pass `${prefix}.${chainId}`
 * if the form contains chain-scoped values (e.g. token addresses).
 * Without that, switching chains would restore stale addresses that no
 * longer resolve in the new chain's token list.
 */
export function useSessionForm<T extends object>(
  key: string,
  defaults: T,
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [state, setState] = useState<T>(() => loadFromStorage(key, defaults));

  // Re-load when the key changes — typically because the chainId baked
  // into it flipped. Without this, useState's lazy initializer wouldn't
  // re-run for a chain switch since the component stays mounted.
  useEffect(() => {
    setState(loadFromStorage(key, defaults));
    // `defaults` is stable across renders for callers that pass an
    // inline literal (React would warn anyway), but adding it as a dep
    // would also re-load on every parent render. Restrict to key only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.sessionStorage.setItem(key, JSON.stringify(state));
    } catch {
      // QuotaExceeded / private-mode / storage disabled → fall back to
      // in-memory only. Form still works for the current navigation,
      // just won't survive a tab switch.
    }
  }, [key, state]);

  return [state, setState];
}

function loadFromStorage<T extends object>(key: string, defaults: T): T {
  if (typeof window === 'undefined') return defaults;
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return defaults;
    }
    // Shallow merge — fields present in `defaults` but missing from the
    // saved blob fall back to the default. Extra fields in the blob
    // (e.g. removed from schema) get carried along harmlessly until the
    // next setState replaces the whole object.
    return { ...defaults, ...parsed };
  } catch {
    return defaults;
  }
}
