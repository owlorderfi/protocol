// Vite injects env vars via import.meta.env. Validate up-front.
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

export const env = {
  apiUrl: resolveApiUrl(),
  chainId: Number(required('VITE_CHAIN_ID', import.meta.env.VITE_CHAIN_ID)),
  routerAddress: required(
    'VITE_LIMIT_ORDER_ROUTER_ADDRESS',
    import.meta.env.VITE_LIMIT_ORDER_ROUTER_ADDRESS,
  ) as `0x${string}`,
  walletConnectProjectId: required(
    'VITE_WALLETCONNECT_PROJECT_ID',
    import.meta.env.VITE_WALLETCONNECT_PROJECT_ID,
  ),
};
