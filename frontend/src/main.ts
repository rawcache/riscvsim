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

type DisasmLine = {
  pc: number;
  text: string;
  label?: boolean;
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
  disasm?: DisasmLine[];
};

const MEM_SIZE = 64 * 1024;
const WINDOW_BYTES = 128;
const BYTES_PER_ROW = 16;
const MAX_RECENT_WRITES = 8;

function hex32(n: number): string {
  const u = n >>> 0;
  return "0x" + u.toString(16).padStart(8, "0");
}

function hex8(n: number): string {
  return (n & 0xff).toString(16).padStart(2, "0");
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

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderRegs(regs?: number[]): string {
  if (!regs || regs.length !== 32) return "";
  const lines: string[] = [];
  for (let i = 0; i < 32; i++) {
    lines.push(`x${i.toString().padStart(2, "0")}: ${hex32(regs[i])}`);
  }
  return lines.join("\n");
}

function renderDisasm(
  pc: number | undefined,
  prevPc: number | undefined,
  disasm?: DisasmLine[]
): string {
  if (!disasm || disasm.length === 0) return "";
  return disasm
    .map((line) => {
      const classes = ["disasm-line"];
      if (line.label) {
        classes.push("label");
      } else {
        if (pc !== undefined && line.pc === pc) {
          classes.push("current");
        } else if (prevPc !== undefined && line.pc === prevPc) {
          classes.push("prev");
        }
      }
      return `<span class="${classes.join(" ")}">${escapeHtml(line.text)}</span>`;
    })
    .join("\n");
}

window.addEventListener("DOMContentLoaded", () => {
  const assembleBtn = document.getElementById("assemble") as HTMLButtonElement;
  const stepBtn = document.getElementById("step") as HTMLButtonElement;
  const sourceEl = document.getElementById("source") as HTMLTextAreaElement;

  const clikeEl = document.getElementById("clike") as HTMLElement;
  const effectsEl = document.getElementById("effects") as HTMLElement;
  const regsEl = document.getElementById("regs") as HTMLElement;
  const pcEl = document.getElementById("pc") as HTMLElement;
  const disasmEl = document.getElementById("disasm") as HTMLElement;
  const memWritesEl = document.getElementById("memWrites") as HTMLElement;
  const memWindowEl = document.getElementById("memWindow") as HTMLElement;
  const statusEl = document.getElementById("status") as HTMLElement;
  const sampleSelect = document.getElementById("sampleSelect") as HTMLSelectElement;

  const memBytes = new Map<number, number>();
  let recentWrites: string[] = [];
  let lastMemAddr: number | undefined;
  let lastPc: number | undefined;

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

  function resetMemoryView() {
    memBytes.clear();
    recentWrites = [];
    lastMemAddr = undefined;
    lastPc = undefined;
    memWritesEl.textContent = "";
    memWindowEl.textContent = "";
  }

  function formatWriteEffect(e: Effect): string {
    const addr = e.addr ?? 0;
    const size = e.size ?? e.afterBytes?.length ?? 0;
    return `${hex32(addr)} (${size}b) ${fmtBytes(e.beforeBytes)} -> ${fmtBytes(e.afterBytes)}`;
  }

  function applyMemEffects(effects: Effect[]) {
    for (const effect of effects) {
      if (effect.kind !== "mem" || effect.addr === undefined || !effect.afterBytes) continue;
      const base = effect.addr >>> 0;
      effect.afterBytes.forEach((value, idx) => {
        const addr = base + idx;
        if (addr >= 0 && addr < MEM_SIZE) {
          memBytes.set(addr, value & 0xff);
        }
      });
      recentWrites.unshift(formatWriteEffect(effect));
      if (recentWrites.length > MAX_RECENT_WRITES) {
        recentWrites = recentWrites.slice(0, MAX_RECENT_WRITES);
      }
      lastMemAddr = base;
    }
  }

  function updateLastPc(effects: Effect[]) {
    const pcEffect = effects.find((effect) => effect.kind === "pc" && effect.before !== undefined);
    if (pcEffect) {
      lastPc = pcEffect.before;
    }
  }

  function renderMemWindow(anchor: number): string {
    const windowStart = clamp(anchor - Math.floor(WINDOW_BYTES / 4), 0, MEM_SIZE - WINDOW_BYTES);
    const lines: string[] = [];
    lines.push(`base ${hex32(windowStart)} (16 bytes/row)`);
    for (let offset = 0; offset < WINDOW_BYTES; offset += BYTES_PER_ROW) {
      const addr = windowStart + offset;
      const bytes: string[] = [];
      for (let i = 0; i < BYTES_PER_ROW; i++) {
        const value = memBytes.get(addr + i) ?? 0;
        bytes.push(hex8(value));
      }
      lines.push(`${hex32(addr)}: ${bytes.join(" ")}`);
    }
    return lines.join("\n");
  }

  function renderAll(data: ApiResponse) {
    statusEl.textContent = "";
    clikeEl.textContent =
      data.clike && data.clike.trim().length > 0 ? data.clike : data.rv2c ?? "";

    const effects = data.effects ?? [];
    applyMemEffects(effects);
    updateLastPc(effects);

    if (data.trap) {
      effectsEl.textContent = `TRAP ${data.trap.code}: ${data.trap.message}`;
    } else {
      effectsEl.textContent = effects.length ? effects.map(fmtEffect).join("\n") : "(no effects)";
    }

    regsEl.textContent = renderRegs(data.regs);
    pcEl.textContent = data.pc !== undefined ? hex32(data.pc) : "";
    disasmEl.innerHTML = renderDisasm(data.pc, lastPc, data.disasm);
    memWritesEl.textContent = recentWrites.length ? recentWrites.join("\n") : "(no writes yet)";
    const anchor = lastMemAddr ?? data.regs?.[2] ?? 0;
    memWindowEl.textContent = renderMemWindow(anchor);

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
      "addi x6, x0, 0x123      # value to store (fits in addi)",
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
    pcEl.textContent = "";
    disasmEl.textContent = "";
    resetMemoryView();
    statusEl.textContent = "";
    sessionId = undefined;
    stepBtn.disabled = true;
    stepBtn.textContent = "Step";
    sourceEl.focus();
  }

  sampleSelect.onchange = () => {
    loadSample(sampleSelect.value || "simpleAdd");
  };

  // Load default sample on first render
  loadSample(sampleSelect.value || "simpleAdd");

  assembleBtn.onclick = async () => {
    effectsEl.textContent = "";
    clikeEl.textContent = "";
    regsEl.textContent = "";
    pcEl.textContent = "";
    disasmEl.textContent = "";
    resetMemoryView();
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
