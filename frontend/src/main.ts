// src/main.ts

console.log("VITE_API_BASE =", import.meta.env.VITE_API_BASE);

let sessionId: string | undefined;
const API_BASE = (import.meta as any).env?.VITE_API_BASE ?? "";

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

  const clikeEl = document.getElementById("clike") as HTMLElement;
  const effectsEl = document.getElementById("effects") as HTMLElement;
  const regsEl = document.getElementById("regs") as HTMLElement;

  async function postJson(url: string, payload: unknown): Promise<ApiResponse> {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const text = await res.text();
    let data: ApiResponse;
    try {
      data = JSON.parse(text) as ApiResponse;
    } catch {
      throw new Error(`Non-JSON response (${res.status}): ${text}`);
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

  assembleBtn.onclick = async () => {
    effectsEl.textContent = "";
    clikeEl.textContent = "";
    regsEl.textContent = "";

    stepBtn.disabled = true;
    stepBtn.textContent = "Step";

    try {
      const source = sourceEl.value;
      const data = await postJson(api("/api/session"), { source });
      sessionId = data.sessionId;
      renderAll(data);
      stepBtn.disabled = false;
    } catch (err) {
      effectsEl.textContent = `Error: ${(err as Error).message}`;
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
