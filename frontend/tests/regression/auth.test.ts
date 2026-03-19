import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeJwtPayload, generateCodeVerifier, isLoggedIn } from "../../src/auth";

type MockStorage = {
  clear(): void;
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
};

function createStorage(): MockStorage {
  const values = new Map<string, string>();
  return {
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.has(key) ? values.get(key) ?? null : null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");

beforeEach(() => {
  const localStorage = createStorage();
  const sessionStorage = createStorage();

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage,
      sessionStorage,
    },
  });
});

afterEach(() => {
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, "window", originalWindowDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, "window");
  }
});

describe("auth helpers", () => {
  it("isLoggedIn returns false when localStorage is empty", () => {
    expect(isLoggedIn()).toBe(false);
  });

  it("isLoggedIn returns false when expiresAt is in the past", () => {
    window.localStorage.setItem("studyriscv_expires_at", String(Date.now() - 1_000));
    expect(isLoggedIn()).toBe(false);
  });

  it("isLoggedIn returns true when expiresAt is in the future", () => {
    window.localStorage.setItem("studyriscv_expires_at", String(Date.now() + 60_000));
    expect(isLoggedIn()).toBe(true);
  });

  it("decodeJwtPayload extracts sub and email from a JWT payload", () => {
    const payload = decodeJwtPayload(
      "header.eyJzdWIiOiJ1c2VyLTEyMyIsImVtYWlsIjoidGVzdEBnYXRlY2guZWR1In0.signature"
    );

    expect(payload.sub).toBe("user-123");
    expect(payload.email).toBe("test@gatech.edu");
  });

  it("generateCodeVerifier returns a URL-safe verifier", () => {
    const verifier = generateCodeVerifier();
    expect(verifier).toMatch(/^[A-Za-z0-9._~-]+$/);
  });
});
