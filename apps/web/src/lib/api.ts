import { env } from './env';

const JWT_KEY = 'polyorder.jwt';

export function getStoredJwt(): string | null {
  return localStorage.getItem(JWT_KEY);
}

export function storeJwt(jwt: string): void {
  localStorage.setItem(JWT_KEY, jwt);
}

export function clearJwt(): void {
  localStorage.removeItem(JWT_KEY);
}

interface ApiOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  auth?: boolean;
}

export async function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const { method = 'GET', body, auth = true } = opts;

  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  if (auth) {
    const jwt = getStoredJwt();
    if (jwt) headers['Authorization'] = `Bearer ${jwt}`;
  }

  const res = await fetch(`${env.apiUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 && auth) {
    clearJwt();
    throw new ApiError(401, 'Unauthorized — JWT cleared, please reconnect wallet');
  }

  if (!res.ok) {
    const text = await res.text();
    let message = text;
    try {
      message = JSON.parse(text).message ?? text;
    } catch {
      // not JSON
    }
    throw new ApiError(res.status, message);
  }

  // 204 No Content
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}
