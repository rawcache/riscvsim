// src/main.ts

import type { ApiResponse, Effect } from "./types";
import { createApiClient } from "./api";
import { renderDisasm } from "./disasm";
import { fmtEffect, hex32, renderRegs } from "./format";
import { createMemoryView } from "./memory";

let sessionId: string | undefined;

const RUN_DELAY_MS = 80;
const MAX_RUN_STEPS = 2000;

window.addEventListener("DOMContentLoaded", () => {
  const assembleBtn = document.getElementById("assemble") as HTMLButtonElement;
  const stepBtn = document.getElementById("step") as HTMLButtonElement;
  const runBtn = document.getElementById("run") as HTMLButtonElement;
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

  const memoryView = createMemoryView();
  let lastPc: number | undefined;
  let runTimer: number | null = null;
  let runSteps = 0;
  const apiClient = createApiClient();

  function resetMemoryView() {
    memoryView.reset();
    lastPc = undefined;
    memWritesEl.textContent = "";
    memWindowEl.textContent = "";
  }

  function stopRun(message?: string) {
    if (runTimer !== null) {
      window.clearInterval(runTimer);
      runTimer = null;
    }
    runSteps = 0;
    runBtn.textContent = "Run";
    if (message) {
      statusEl.textContent = message;
    }
  }

  function updateLastPc(effects: Effect[]) {
    const pcEffect = effects.find((effect) => effect.kind === "pc" && effect.before !== undefined);
    if (pcEffect) {
      lastPc = pcEffect.before;
    }
  }

  function isPcStalled(effects: Effect[]): boolean {
    const pcEffect = effects.find(
      (effect) =>
        effect.kind === "pc" && effect.before !== undefined && effect.after !== undefined
    );
    return pcEffect ? pcEffect.before === pcEffect.after : false;
  }

  function renderAll(data: ApiResponse) {
    statusEl.textContent = "";
    clikeEl.textContent =
      data.clike && data.clike.trim().length > 0 ? data.clike : data.rv2c ?? "";

    const effects = data.effects ?? [];
    memoryView.applyEffects(effects);
    updateLastPc(effects);

    if (data.trap) {
      effectsEl.textContent = `TRAP ${data.trap.code}: ${data.trap.message}`;
    } else {
      effectsEl.textContent = effects.length ? effects.map(fmtEffect).join("\n") : "(no effects)";
    }

    regsEl.textContent = renderRegs(data.regs);
    pcEl.textContent = data.pc !== undefined ? hex32(data.pc) : "";
    disasmEl.innerHTML = renderDisasm(data.pc, lastPc, data.disasm);
    const recentWrites = memoryView.getRecentWrites();
    memWritesEl.textContent = recentWrites.length ? recentWrites.join("\n") : "(no writes yet)";
    const anchor = memoryView.getLastAddr() ?? data.regs?.[2] ?? 0;
    memWindowEl.textContent = memoryView.renderWindow(anchor);

    const halted = data.halted === true;
    const stalled = isPcStalled(effects);
    if (halted || stalled) {
      stepBtn.disabled = true;
      stepBtn.textContent = "Halted";
      stopRun(stalled && !halted ? "Halt loop detected." : "Program halted.");
      statusEl.textContent = stalled && !halted ? "Halt loop detected." : "Program halted.";
      assembleBtn.disabled = false;
    } else {
      stepBtn.textContent = "Step";
    }
    runBtn.disabled = !sessionId || halted || stalled;
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
    memoryTests: [
      "# Sample: memory writes and signed/unsigned loads",
      "addi x1, x0, 64       # base address",
      "addi x2, x0, 0x7a5    # test value (fits in addi)",
      "sw   x2, 0(x1)        # store word",
      "sb   x2, 4(x1)        # store low byte (0xa5)",
      "sh   x2, 6(x1)        # store low half (0x07a5)",
      "lw   x3, 0(x1)        # load word",
      "lb   x4, 4(x1)        # sign-extended byte",
      "lbu  x5, 4(x1)        # zero-extended byte",
      "lh   x6, 6(x1)        # sign-extended half",
      "lhu  x7, 6(x1)        # zero-extended half",
      "beq x0, x0, done",
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
    stopRun();
    assembleBtn.disabled = false;
    stepBtn.disabled = true;
    stepBtn.textContent = "Step";
    runBtn.disabled = true;
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
    runBtn.disabled = true;
    stopRun();

    try {
      const programText = sourceEl.value;
      const data = await apiClient.postJson("/api/session", { source: programText });
      sessionId = data.sessionId;
      renderAll(data);
      stepBtn.disabled = !sessionId;
      runBtn.disabled = !sessionId;
    } catch (err) {
      effectsEl.textContent = `Error: ${(err as Error).message}`;
      sessionId = undefined;
      statusEl.textContent = "";
      runBtn.disabled = true;
    }
  };

  stepBtn.onclick = async () => {
    if (!sessionId) {
      effectsEl.textContent = "Error: no sessionId. Click Assemble first.";
      return;
    }

    try {
      const data = await apiClient.postJson("/api/step", { sessionId });
      renderAll(data);
    } catch (err) {
      effectsEl.textContent = `Error: ${(err as Error).message}`;
    }
  };

  runBtn.onclick = async () => {
    if (!sessionId) {
      effectsEl.textContent = "Error: no sessionId. Click Assemble first.";
      return;
    }

    if (runTimer !== null) {
      stopRun("Run stopped.");
      assembleBtn.disabled = false;
      stepBtn.disabled = !sessionId;
      runBtn.disabled = !sessionId;
      return;
    }

    assembleBtn.disabled = true;
    stepBtn.disabled = true;
    runBtn.textContent = "Stop";
    statusEl.textContent = "Running…";
    runSteps = 0;

    runTimer = window.setInterval(async () => {
      if (!sessionId) {
        stopRun();
        assembleBtn.disabled = false;
        stepBtn.disabled = !sessionId;
        runBtn.disabled = !sessionId;
        return;
      }
      if (runSteps >= MAX_RUN_STEPS) {
        stopRun(`Run stopped after ${MAX_RUN_STEPS} steps.`);
        assembleBtn.disabled = false;
        stepBtn.disabled = !sessionId;
        runBtn.disabled = !sessionId;
        return;
      }
      runSteps += 1;
      try {
        const data = await apiClient.postJson("/api/step", { sessionId });
        renderAll(data);
        if (data.halted) {
          stopRun("Program halted.");
          assembleBtn.disabled = false;
          stepBtn.disabled = true;
          runBtn.disabled = true;
        }
      } catch (err) {
        stopRun(`Error: ${(err as Error).message}`);
        assembleBtn.disabled = false;
        stepBtn.disabled = !sessionId;
        runBtn.disabled = !sessionId;
      }
    }, RUN_DELAY_MS);
  };
});
