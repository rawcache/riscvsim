import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getSessionMock } = vi.hoisted(() => {
  return {
    getSessionMock: vi.fn(),
  };
});

vi.mock("../../src/auth", () => {
  return {
    getSession: getSessionMock,
  };
});

import {
  ApiError,
  AuthRequiredError,
  LimitReachedError,
  NotFoundError,
  deleteProgram,
  getPrograms,
  saveProgram,
  updateProgram,
} from "../../src/programs-api";

const originalFetch = globalThis.fetch;

function okJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

describe("programs API client", () => {
  beforeEach(() => {
    getSessionMock.mockReset();
    getSessionMock.mockResolvedValue({
      idToken: "test-id-token",
    });
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it("throws AuthRequiredError before requesting when no session exists", async () => {
    getSessionMock.mockResolvedValue(null);

    await expect(getPrograms()).rejects.toBeInstanceOf(AuthRequiredError);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("throws LimitReachedError on 403 LIMIT_REACHED", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      okJson(
        {
          error: "LIMIT_REACHED",
          message: "Free accounts can save up to 3 programs. Upgrade to Pro for unlimited saves.",
          limit: 3,
        },
        403
      )
    );

    try {
      await saveProgram("My program", "addi x1, x0, 1");
      throw new Error("Expected saveProgram to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(LimitReachedError);
      expect((error as LimitReachedError).limit).toBe(3);
    }
  });

  it("throws NotFoundError on 404", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      okJson(
        {
          error: "NOT_FOUND",
          message: "Program not found.",
        },
        404
      )
    );

    await expect(updateProgram("missing-id", "Example", "addi x1, x0, 1")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws ApiError on 500", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      okJson(
        {
          error: "INTERNAL_ERROR",
          message: "Something went wrong.",
        },
        500
      )
    );

    await expect(getPrograms()).rejects.toBeInstanceOf(ApiError);
  });

  it("sets the Authorization header from the id token", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      okJson({
        programs: [],
        tier: "free",
        count: 0,
      })
    );

    await getPrograms();

    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer test-id-token");
  });

  it("sends the correct request body when saving a program", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      okJson(
        {
          programId: "abc123",
          name: "My program",
          source: "addi x1, x0, 1",
          createdAt: "2026-03-19T00:00:00.000Z",
          updatedAt: "2026-03-19T00:00:00.000Z",
        },
        201
      )
    );

    await saveProgram("  My program  ", "addi x1, x0, 1");

    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      name: "My program",
      source: "addi x1, x0, 1",
    });
  });

  it("sends DELETE to the correct program URL", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response(null, { status: 204 }));

    await deleteProgram("abc123");

    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    expect(url).toBe("https://hsyyxozom8.execute-api.us-east-1.amazonaws.com/programs/abc123");
    expect(init?.method).toBe("DELETE");
  });
});
