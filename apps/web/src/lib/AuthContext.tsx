import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import { useAccount, useSignMessage, useDisconnect } from 'wagmi';
import { api, getStoredJwt, storeJwt, clearJwt } from './api';

interface NonceResponse {
  nonce: string;
  message: string;
  expiresAt: string;
}

interface LoginResponse {
  accessToken: string;
  expiresAt: string;
  user: { walletAddress: string };
}

interface JwtPayload {
  sub: string; // walletAddress (lowercased)
  exp: number; // seconds since epoch
}

function decodeJwt(jwt: string): JwtPayload | null {
  try {
    const [, payload] = jwt.split('.');
    return JSON.parse(atob(payload));
  } catch {
    return null;
  }
}

interface AuthValue {
  isAuthed: boolean;
  authedAddress: string | null;
  isLoggingIn: boolean;
  loginError: string | null;
  mismatch: boolean;
  login: () => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthValue | null>(null);

/**
 * Single source of truth for auth state — placed once at the app root so
 * Header, App, and OrdersList all see the same `isAuthed` flag.
 * Without this, each useState instance diverges after login() and components
 * stay stale until a page refresh re-reads JWT from localStorage.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { disconnect } = useDisconnect();

  const [authedAddress, setAuthedAddress] = useState<string | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  // On mount, sync state with JWT from localStorage
  useEffect(() => {
    const jwt = getStoredJwt();
    if (!jwt) {
      setAuthedAddress(null);
      return;
    }
    const payload = decodeJwt(jwt);
    if (!payload || payload.exp * 1000 < Date.now()) {
      clearJwt();
      setAuthedAddress(null);
      return;
    }
    setAuthedAddress(payload.sub.toLowerCase());
  }, []);

  const login = useCallback(async (): Promise<void> => {
    if (!address) {
      setLoginError('No wallet connected');
      return;
    }
    setIsLoggingIn(true);
    setLoginError(null);
    try {
      const { nonce, message } = await api<NonceResponse>('/auth/nonce', {
        method: 'POST',
        body: { walletAddress: address },
        auth: false,
      });

      const signature = await signMessageAsync({ message });

      const loginResp = await api<LoginResponse>('/auth/login', {
        method: 'POST',
        body: { walletAddress: address, nonce, signature },
        auth: false,
      });

      storeJwt(loginResp.accessToken);
      setAuthedAddress(address.toLowerCase());
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setIsLoggingIn(false);
    }
  }, [address, signMessageAsync]);

  const logout = useCallback(() => {
    clearJwt();
    setAuthedAddress(null);
    disconnect();
  }, [disconnect]);

  const mismatch =
    isConnected &&
    address !== undefined &&
    authedAddress !== null &&
    address.toLowerCase() !== authedAddress;

  const value: AuthValue = {
    // A stored JWT alone isn't a usable session — the wallet has to be
    // connected too. Otherwise a persisted JWT with a disconnected wallet
    // shows "Sign out" while RainbowKit simultaneously shows "Connect
    // Wallet" (contradictory). The JWT stays in storage, so reconnecting
    // the same address re-derives isAuthed without forcing a re-sign.
    isAuthed: isConnected && authedAddress !== null && !mismatch,
    authedAddress,
    isLoggingIn,
    loginError,
    mismatch,
    login,
    logout,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
