// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { logout } from "../../src/auth";
import { saveProgress, loadProgress, getProgressStorageKey, type UserProgress } from "../../src/lessons";
import { initNav } from "../../src/nav";

function createStorageMock(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.has(key) ? values.get(key) ?? null : null;
    },
    key(index: number) {
      return Array.from(values.keys())[index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}

function createJwt(payload: Record<string, unknown>): string {
  const encoded = btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return `header.${encoded}.signature`;
}

function sampleProgress(): UserProgress {
  return {
    lessons: {
      "lesson-1-registers": {
        lessonId: "lesson-1-registers",
        completed: false,
        currentStepIndex: 2,
        stepsCompleted: ["lesson-1-step-1", "lesson-1-step-2"],
        startedAt: "2026-03-24T00:00:00.000Z",
        attempts: 1,
      },
    },
    totalCompleted: 0,
    lastActiveLesson: "lesson-1-registers",
  };
}

describe("progress isolation and logout", () => {
  const originalLocalStorage = globalThis.localStorage;
  const originalSessionStorage = globalThis.sessionStorage;

  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: createStorageMock(),
    });
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: createStorageMock(),
    });
    document.body.innerHTML = '<nav id="site-nav"></nav>';
    window.history.replaceState({}, "", "/simulator/");
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: originalLocalStorage,
    });
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: originalSessionStorage,
    });
    document.body.innerHTML = "";
    window.history.replaceState({}, "", "/");
  });

  it("namespaces progress storage by user id", () => {
    localStorage.setItem("studyriscv_id_token", createJwt({ sub: "user-123", email: "user@example.com" }));

    saveProgress(sampleProgress());

    expect(getProgressStorageKey()).toBe("studyriscv_lesson_progress:user-123");
    expect(localStorage.getItem("studyriscv_lesson_progress:user-123")).not.toBeNull();
    expect(localStorage.getItem("studyriscv_lesson_progress")).toBeNull();
  });

  it("progress state is empty immediately after logout", () => {
    localStorage.setItem("studyriscv_id_token", createJwt({ sub: "user-123", email: "user@example.com" }));
    localStorage.setItem("studyriscv_access_token", "access-token");
    localStorage.setItem("studyriscv_expires_at", String(Date.now() + 60_000));
    saveProgress(sampleProgress());

    logout({
      userPoolId: "pool",
      clientId: "client",
      hostedUiDomain: "example.auth.us-east-1.amazoncognito.com",
      redirectUri: "https://studyriscv.com/simulator/",
    });

    expect(loadProgress()).toEqual({
      lessons: {},
      totalCompleted: 0,
    });
  });

  it('window.location.href is "/" after logout completes', () => {
    localStorage.setItem("studyriscv_id_token", createJwt({ sub: "user-123", email: "user@example.com" }));
    localStorage.setItem("studyriscv_access_token", "access-token");
    localStorage.setItem("studyriscv_expires_at", String(Date.now() + 60_000));

    logout({
      userPoolId: "pool",
      clientId: "client",
      hostedUiDomain: "example.auth.us-east-1.amazoncognito.com",
      redirectUri: "https://studyriscv.com/simulator/",
    });

    expect(window.location.pathname).toBe("/");
  });

  it('logged-out nav renders no "Continue" banner', async () => {
    initNav({ activePage: "learn" });
    await vi.waitFor(() => {
      expect(document.getElementById("site-nav")?.textContent ?? "").not.toContain("Continue");
    });
  });
});
