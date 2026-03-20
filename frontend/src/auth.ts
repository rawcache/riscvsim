import { AUTH_CONFIG } from "./auth-config";

export interface AuthConfig {
  userPoolId: string;
  clientId: string;
  hostedUiDomain: string;
  redirectUri: string;
}

export interface UserSession {
  userId: string;
  email: string;
  isGtStudent: boolean;
  idToken: string;
  accessToken: string;
  expiresAt: number;
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

type BufferLike = {
  from(input: Uint8Array | string, encoding?: string): { toString(encoding: string): string } | Uint8Array;
};

type NodeRequire = (moduleName: string) => {
  randomBytes?: (size: number) => Uint8Array;
};

type TokenResponse = {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
};

type SessionTokenInput = {
  idToken: string;
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
};

const ID_TOKEN_KEY = "studyriscv_id_token";
const ACCESS_TOKEN_KEY = "studyriscv_access_token";
const EXPIRES_AT_KEY = "studyriscv_expires_at";
const REFRESH_TOKEN_KEY = "studyriscv_refresh_token";

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

function getLocalStorage(): StorageLike | null {
  return hasWindow() ? window.localStorage : null;
}

function getSessionStorage(): StorageLike | null {
  return hasWindow() ? window.sessionStorage : null;
}

function getBufferLike(): BufferLike | null {
  return ((globalThis as typeof globalThis & { Buffer?: BufferLike }).Buffer ?? null) as BufferLike | null;
}

function getNodeRequire(): NodeRequire | null {
  const nodeProcess = (globalThis as typeof globalThis & {
    process?: { versions?: { node?: string } };
  }).process;
  if (!nodeProcess?.versions?.node) {
    return null;
  }

  try {
    return Function("return typeof require !== 'undefined' ? require : null")() as NodeRequire | null;
  } catch {
    return null;
  }
}

function encodeBase64(bytes: Uint8Array): string {
  const bufferLike = getBufferLike();
  if (bufferLike) {
    return (bufferLike.from(bytes) as { toString(encoding: string): string }).toString("base64");
  }

  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function decodeBase64(base64: string): Uint8Array {
  const bufferLike = getBufferLike();
  if (bufferLike) {
    return Uint8Array.from(bufferLike.from(base64, "base64") as Uint8Array);
  }

  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function base64UrlEncode(bytes: Uint8Array): string {
  return encodeBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(input: string): Uint8Array {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return decodeBase64(normalized + padding);
}

function normalizeHostedUiDomain(hostedUiDomain: string): string {
  return hostedUiDomain.replace(/^https?:\/\//i, "").replace(/\/+$/g, "");
}

function hostedUiUrl(hostedUiDomain: string, path: string): string {
  return `https://${normalizeHostedUiDomain(hostedUiDomain)}${path}`;
}

function clearStoredTokens(): void {
  const localStorageRef = getLocalStorage();
  const sessionStorageRef = getSessionStorage();
  localStorageRef?.removeItem(ID_TOKEN_KEY);
  localStorageRef?.removeItem(ACCESS_TOKEN_KEY);
  localStorageRef?.removeItem(EXPIRES_AT_KEY);
  sessionStorageRef?.removeItem(REFRESH_TOKEN_KEY);
}

function buildSession(idToken: string, accessToken: string, expiresAt: number): UserSession | null {
  try {
    const payload = decodeJwtPayload(idToken);
    const userId = typeof payload.sub === "string" ? payload.sub : "";
    const email = typeof payload.email === "string" ? payload.email : "";
    if (!userId || !email) {
      return null;
    }

    return {
      userId,
      email,
      isGtStudent: email.toLowerCase().endsWith("@gatech.edu"),
      idToken,
      accessToken,
      expiresAt,
    };
  } catch {
    return null;
  }
}

async function tokenRequest(config: AuthConfig, params: URLSearchParams): Promise<TokenResponse | null> {
  const response = await fetch(hostedUiUrl(config.hostedUiDomain, "/oauth2/token"), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!response.ok) {
    return null;
  }

  return (await response.json()) as TokenResponse;
}

function persistTokens(tokens: TokenResponse, expiresIn: number): UserSession | null {
  const localStorageRef = getLocalStorage();
  const sessionStorageRef = getSessionStorage();
  if (!localStorageRef || !sessionStorageRef || !tokens.id_token || !tokens.access_token) {
    return null;
  }

  const expiresAt = Date.now() + expiresIn * 1000;
  localStorageRef.setItem(ID_TOKEN_KEY, tokens.id_token);
  localStorageRef.setItem(ACCESS_TOKEN_KEY, tokens.access_token);
  localStorageRef.setItem(EXPIRES_AT_KEY, String(expiresAt));
  if (tokens.refresh_token) {
    sessionStorageRef.setItem(REFRESH_TOKEN_KEY, tokens.refresh_token);
  }

  return buildSession(tokens.id_token, tokens.access_token, expiresAt);
}

async function refreshSession(config: AuthConfig = AUTH_CONFIG): Promise<UserSession | null> {
  const sessionStorageRef = getSessionStorage();
  if (!sessionStorageRef) {
    return null;
  }

  const refreshToken = sessionStorageRef.getItem(REFRESH_TOKEN_KEY);
  if (!refreshToken) {
    return null;
  }

  try {
    const tokens = await tokenRequest(
      config,
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: config.clientId,
      })
    );

    if (!tokens?.id_token || !tokens.access_token || typeof tokens.expires_in !== "number") {
      clearStoredTokens();
      return null;
    }

    return persistTokens(tokens, tokens.expires_in);
  } catch {
    clearStoredTokens();
    return null;
  }
}

function getRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
    return bytes;
  }

  const nodeRequire = getNodeRequire();
  const nodeCrypto = nodeRequire?.("node:crypto");
  if (nodeCrypto?.randomBytes) {
    return Uint8Array.from(nodeCrypto.randomBytes(length));
  }

  throw new Error("No secure random source available.");
}

export function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length < 2) {
    throw new Error("Invalid JWT.");
  }

  const json = new TextDecoder().decode(base64UrlDecode(parts[1]));
  return JSON.parse(json) as Record<string, unknown>;
}

export function generateCodeVerifier(): string {
  return base64UrlEncode(getRandomBytes(96));
}

export function storeSessionTokens(tokens: SessionTokenInput): UserSession | null {
  return persistTokens(
    {
      id_token: tokens.idToken,
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      expires_in: tokens.expiresIn,
    },
    tokens.expiresIn
  );
}

export async function getSession(): Promise<UserSession | null> {
  const localStorageRef = getLocalStorage();
  if (!localStorageRef) {
    return null;
  }

  const idToken = localStorageRef.getItem(ID_TOKEN_KEY);
  const accessToken = localStorageRef.getItem(ACCESS_TOKEN_KEY);
  const expiresAt = Number(localStorageRef.getItem(EXPIRES_AT_KEY));

  if (!idToken || !accessToken || !Number.isFinite(expiresAt)) {
    return null;
  }

  if (expiresAt < Date.now() + 60_000) {
    return refreshSession();
  }

  return buildSession(idToken, accessToken, expiresAt);
}

export function login(config: AuthConfig = AUTH_CONFIG): void {
  if (!hasWindow()) {
    return;
  }

  void import("./auth-page").then(({ show }) => {
    show({ config });
  });
}

export function logout(config: AuthConfig): void {
  clearStoredTokens();
  if (!hasWindow()) {
    return;
  }

  const logoutUri = config.redirectUri?.trim() || new URL("/", window.location.origin).toString();
  const params = new URLSearchParams({
    client_id: config.clientId,
    logout_uri: logoutUri,
  });
  window.location.assign(hostedUiUrl(config.hostedUiDomain, `/logout?${params.toString()}`));
}

export function isLoggedIn(): boolean {
  const localStorageRef = getLocalStorage();
  if (!localStorageRef) {
    return false;
  }

  const expiresAt = Number(localStorageRef.getItem(EXPIRES_AT_KEY));
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}
