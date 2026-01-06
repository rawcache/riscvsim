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

type Trap = {
  code: string;
  message: string;
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
  trap?: Trap | null;
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
  const statusEl = document.getElementById("status") as HTMLElement;
  const sampleSelect = document.getElementById("sampleSelect") as HTMLSelectElement;

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
    statusEl.textContent = "";
    clikeEl.textContent =
      data.clike && data.clike.trim().length > 0 ? data.clike : data.rv2c ?? "";

    if (data.trap) {
      effectsEl.textContent = `TRAP ${data.trap.code}: ${data.trap.message}`;
    } else {
      const effects = data.effects ?? [];
      effectsEl.textContent = effects.length ? effects.map(fmtEffect).join("\n") : "(no effects)";
    }

    regsEl.textContent = renderRegs(data.regs);

    if (data.halted) {
      stepBtn.disabled = true;
      stepBtn.textContent = "Halted";
    } else {
      stepBtn.textContent = "Step";
    }
  }

  const samplePrograms: Record<string, string> = {
    simpleAdd: [
      "# Sample: add two numbers and halt",
      "addi x1, x0, 5        # x1 = 5",
      "addi x2, x0, 7        # x2 = 7",
      "addi x3, x2, 5        # x3 = x2 + 5 = 12",
      "beq x0, x0, done      # branch past program to halt",
      "done:",
    ].join("\n"),
    jalLwSw: [
      "# Sample: jal/jalr with lw/sw round trip",
      "addi x5, x0, 0x100      # buffer addr",
      "lui  x6, 0x12345        # x6 = 0x12345000",
      "addi x6, x6, 0x678      # x6 = 0x12345678",
      "sw   x6, 0(x5)          # store word",
      "jal  ra, load_back      # call",
      "addi x10, x7, 0         # copy after return",
      "halt:",
      "beq  x0, x0, halt       # halt loop",
      "load_back:",
      "lw   x7, 0(x5)",
      "jalr x0, 0(ra)",
    ].join("\n"),
    loopsUnsigned: [
      "# Sample: unsigned vs signed branches",
      "addi x1, x0, -1      # 0xffffffff",
      "addi x2, x0, 1",
      "bltu x1, x2, not_taken",
      "addi x3, x0, 123",
      "not_taken:",
      "bgeu x1, x2, done",
      "addi x3, x0, 999",
      "done:",
      "beq x0, x0, done",
    ].join("\n"),
  };

  function loadSample(name: string) {
    const program = samplePrograms[name] ?? "";
    sourceEl.value = program;
    effectsEl.textContent = "";
    clikeEl.textContent = "";
    regsEl.textContent = "";
    statusEl.textContent = "";
    sessionId = undefined;
    stepBtn.disabled = true;
    stepBtn.textContent = "Step";
    sourceEl.focus();
  }

  loadSampleBtn.onclick = () => {
    loadSample(sampleSelect.value || "simpleAdd");
  };

  assembleBtn.onclick = async () => {
    effectsEl.textContent = "";
    clikeEl.textContent = "";
    regsEl.textContent = "";
    statusEl.textContent = "Assembling…";

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
      statusEl.textContent = "";
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
