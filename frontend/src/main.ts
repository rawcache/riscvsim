// src/main.ts

let sessionId: string | undefined;

function resolveApiBase(): string {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get("api");
  if (fromQuery) return fromQuery.replace(/\/$/, "");

  const fromEnv = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";
  return fromEnv.replace(/\/$/, "");
}

const API_BASE = resolveApiBase();

function api(path: string): string {
  return `${API_BASE}${path}`;
}

type Effect = {
  kind: string; // "reg" | "mem" | "pc"
  reg?: number;
  addr?: number;
  size?: number;
  before?: number;
  after?: number;
  beforeBytes?: number[];
  afterBytes?: number[];
};

type ApiResponse = {
  sessionId?: string;
  pc?: number;
  regs?: number[];
  halted?: boolean;
  effects?: Effect[];
  clike?: string;
  rv2c?: string;
  error?: string | null;
};

function hex32(n: number): string {
  const u = n >>> 0;
  return "0x" + u.toString(16).padStart(8, "0");
}

function fmtBytes(bytes?: number[]): string {
  if (!bytes || bytes.length === 0) return "[]";
  return (
    "[" +
    bytes.map((b) => "0x" + (b & 0xff).toString(16).padStart(2, "0")).join(" ") +
    "]"
  );
}

function fmtEffect(e: Effect): string {
  if (e.kind === "pc") {
    return `PC ${hex32(e.before ?? 0)} -> ${hex32(e.after ?? 0)}`;
  }
  if (e.kind === "reg") {
    return `REG x${e.reg ?? -1} ${hex32(e.before ?? 0)} -> ${hex32(e.after ?? 0)}`;
  }
  if (e.kind === "mem") {
    return `MEM [${hex32(e.addr ?? 0)}] ${fmtBytes(e.beforeBytes)} -> ${fmtBytes(
      e.afterBytes
    )}`;
  }
  return `Effect(${e.kind})`;
}

function renderRegs(regs?: number[]): string {
  if (!regs || regs.length !== 32) return "";
  const lines: string[] = [];
  for (let i = 0; i < 32; i++) {
    lines.push(`x${i.toString().padStart(2, "0")}: ${hex32(regs[i])}`);
  }
  return lines.join("\n");
}

window.addEventListener("DOMContentLoaded", () => {
  const assembleBtn = document.getElementById("assemble") as HTMLButtonElement;
  const stepBtn = document.getElementById("step") as HTMLButtonElement;
  const sourceEl = document.getElementById("source") as HTMLTextAreaElement;
  const loadSampleBtn = document.getElementById("loadSample") as HTMLButtonElement;

  const clikeEl = document.getElementById("clike") as HTMLElement;
  const effectsEl = document.getElementById("effects") as HTMLElement;
  const regsEl = document.getElementById("regs") as HTMLElement;

  function nonJsonError(status: number, text: string): string {
    if (status === 404 && text.includes("<!DOCTYPE")) {
      return "Backend endpoint not found (got HTML). Start the backend (see README) or set VITE_API_BASE or ?api= to your backend URL.";
    }
    const snippet = text.length > 200 ? `${text.slice(0, 200)}…` : text;
    return `Non-JSON response (${status}): ${snippet}`;
  }

  async function postJson(url: string, payload: unknown): Promise<ApiResponse> {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const text = await res.text();
    const contentType = res.headers.get("Content-Type") ?? "";

    let data: ApiResponse;
    if (contentType.includes("application/json")) {
      try {
        data = JSON.parse(text) as ApiResponse;
      } catch {
        throw new Error(`Non-JSON response (${res.status}): ${text}`);
      }
    } else {
      throw new Error(nonJsonError(res.status, text));
    }

    if (!res.ok) {
      throw new Error(data.error ?? `HTTP ${res.status}`);
    }
    return data;
  }

  function renderAll(data: ApiResponse) {
    clikeEl.textContent =
      data.clike && data.clike.trim().length > 0 ? data.clike : data.rv2c ?? "";

    const effects = data.effects ?? [];
    effectsEl.textContent = effects.length ? effects.map(fmtEffect).join("\n") : "(no effects)";

    regsEl.textContent = renderRegs(data.regs);

    if (data.halted) {
      stepBtn.disabled = true;
      stepBtn.textContent = "Halted";
    } else {
      stepBtn.textContent = "Step";
    }
  }

  const sampleProgram = [
    "# Sample: add two numbers (supported opcodes only) and halt",
    "addi x1, x0, 5        # x1 = 5",
    "addi x2, x0, 7        # x2 = 7",
    "addi x3, x2, 5        # x3 = x2 + 5 = 12",
    "beq x0, x0, done      # branch past program to halt",
    "done:",
    "",
  ].join("\n");

  loadSampleBtn.onclick = () => {
    sourceEl.value = sampleProgram;
    effectsEl.textContent = "";
    clikeEl.textContent = "";
    regsEl.textContent = "";
    sessionId = undefined;
    stepBtn.disabled = true;
    stepBtn.textContent = "Step";
    sourceEl.focus();
  };

  assembleBtn.onclick = async () => {
    effectsEl.textContent = "";
    clikeEl.textContent = "";
    regsEl.textContent = "";

    stepBtn.disabled = true;
    stepBtn.textContent = "Step";

    try {
      const programText = sourceEl.value;
      const data = await postJson(api("/api/session"), { source: programText });
      sessionId = data.sessionId;
      renderAll(data);
      stepBtn.disabled = !sessionId;
    } catch (err) {
      effectsEl.textContent = `Error: ${(err as Error).message}`;
      sessionId = undefined;
    }
  };

  stepBtn.onclick = async () => {
    if (!sessionId) {
      effectsEl.textContent = "Error: no sessionId. Click Assemble first.";
      return;
    }

    try {
      const data = await postJson(api("/api/step"), { sessionId });
      renderAll(data);
    } catch (err) {
      effectsEl.textContent = `Error: ${(err as Error).message}`;
    }
  };
});
