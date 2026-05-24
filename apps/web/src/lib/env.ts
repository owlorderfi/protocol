// Vite injects env vars via import.meta.env. Validate up-front.

const HEX_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

// If VITE_API_URL is "auto", derive it from the page's host so the same build
// works whether you visit on localhost or over LAN IP. Otherwise use the explicit value.
function resolveApiUrl(): string {
  const explicit = import.meta.env.VITE_API_URL;
  if (explicit && explicit !== 'auto') return explicit;
  if (typeof window === 'undefined') throw new Error('VITE_API_URL must be set for SSR');
  return `${window.location.protocol}//${window.location.hostname}:4001`;
}

/**
 * Parse every `VITE_CHAIN_<id>_ROUTER` env var into a chainId → router map.
 * This lets the UI ship with multiple deployments configured and the wallet
 * pick which one's active. Validates each value is a hex address.
 *
 * Falls back to the legacy single-chain `VITE_LIMIT_ORDER_ROUTER_ADDRESS`
 * paired with `VITE_CHAIN_ID` so existing builds keep working unchanged.
 */
function loadRouters(): Record<number, `0x${string}`> {
  const routers: Record<number, `0x${string}`> = {};
  const all = import.meta.env as Record<string, string | undefined>;
  for (const key of Object.keys(all)) {
    const m = key.match(/^VITE_CHAIN_(\d+)_ROUTER$/);
    if (!m) continue;
    const chainId = Number(m[1]);
    const value = all[key];
    if (!value || !HEX_ADDRESS_RE.test(value)) {
      // eslint-disable-next-line no-console
      console.warn(`[env] ${key} is not a valid 0x-prefixed 20-byte address — ignored`);
      continue;
    }
    routers[chainId] = value as `0x${string}`;
  }

  // Backwards-compat: lift the legacy pair into the map if no per-chain
  // entry exists for the legacy chainId. Lets old builds upgrade without
  // editing .env first.
  const legacyChainId = Number(import.meta.env.VITE_CHAIN_ID);
  const legacyRouter = import.meta.env.VITE_LIMIT_ORDER_ROUTER_ADDRESS;
  if (
    legacyChainId &&
    legacyRouter &&
    HEX_ADDRESS_RE.test(legacyRouter) &&
    !(legacyChainId in routers)
  ) {
    routers[legacyChainId] = legacyRouter as `0x${string}`;
  }

  if (Object.keys(routers).length === 0) {
    throw new Error(
      'No router addresses configured. Set at least one VITE_CHAIN_<id>_ROUTER ' +
        '(or the legacy VITE_CHAIN_ID + VITE_LIMIT_ORDER_ROUTER_ADDRESS pair) in apps/web/.env.',
    );
  }
  return routers;
}

/**
 * Parse `VITE_CHAIN_<id>_KEEPERS=0xaaa,0xbbb,...` into a chainId →
 * keeper address list map. Used by the admin dashboard to surface
 * authorized keepers' status. Optional — missing chains just hide
 * the keepers panel rather than throwing.
 */
function loadKeepers(): Record<number, `0x${string}`[]> {
  const result: Record<number, `0x${string}`[]> = {};
  const all = import.meta.env as Record<string, string | undefined>;
  for (const key of Object.keys(all)) {
    const m = key.match(/^VITE_CHAIN_(\d+)_KEEPERS$/);
    if (!m) continue;
    const chainId = Number(m[1]);
    const value = all[key];
    if (!value) continue;
    const addrs = value
      .split(',')
      .map((s) => s.trim())
      .filter((s) => HEX_ADDRESS_RE.test(s)) as `0x${string}`[];
    if (addrs.length > 0) result[chainId] = addrs;
  }
  return result;
}

const routers = loadRouters();
const keepers = loadKeepers();

// VITE_CHAIN_ID picks the default chain shown before the wallet connects.
// Optional now — falls back to the first configured router so a
// single-chain deploy with one VITE_CHAIN_<id>_ROUTER doesn't need a
// second redundant env var.
const configuredChainIds = Object.keys(routers).map(Number);
const envChainId = import.meta.env.VITE_CHAIN_ID
  ? Number(import.meta.env.VITE_CHAIN_ID)
  : configuredChainIds[0];
const defaultChainId = envChainId;

if (!(defaultChainId in routers)) {
  throw new Error(
    `VITE_CHAIN_ID=${defaultChainId} has no matching router. ` +
      `Configured chains: ${configuredChainIds.join(', ')}.`,
  );
}

export const env = {
  apiUrl: resolveApiUrl(),
  /** Default chain — used pre-wallet-connect and as a fallback. */
  chainId: defaultChainId,
  /** Router address for the default chain (kept for back-compat call sites). */
  routerAddress: routers[defaultChainId],
  /** Full chainId → router map — all configured deployments. */
  routers,
  /** List of all configured chain IDs. */
  chainIds: Object.keys(routers).map(Number),
  /** chainId → known authorized keeper addresses (from VITE_CHAIN_<id>_KEEPERS). */
  keepers,
  walletConnectProjectId: required(
    'VITE_WALLETCONNECT_PROJECT_ID',
    import.meta.env.VITE_WALLETCONNECT_PROJECT_ID,
  ),
};

/**
 * Lookup the router address for an arbitrary chainId. Throws when no
 * router is configured for that chain — better to fail loud than sign
 * an EIP-712 message against an address the keeper / contract can't
 * see.
 */
export function getRouterForChain(chainId: number): `0x${string}` {
  const r = routers[chainId];
  if (!r) {
    throw new Error(
      `No router configured for chainId ${chainId}. ` +
        `Configured chains: ${Object.keys(routers).join(', ')}.`,
    );
  }
  return r;
}
