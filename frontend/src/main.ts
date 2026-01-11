// ~/frontend/src/main.ts

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
  const stepBackBtn = document.getElementById("stepBack") as HTMLButtonElement;
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
  let assembleTimer: number | null = null;
  let runSteps = 0;
  let history: ApiResponse[] = [];
  let historyIndex = -1;
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

  function setHistory(data: ApiResponse) {
    history = [data];
    historyIndex = 0;
  }

  function pushHistory(data: ApiResponse) {
    history.push(data);
    historyIndex = history.length - 1;
  }

  function syncHistoryControls() {
    const hasSession = Boolean(sessionId);
    const atHistoryEnd = historyIndex >= history.length - 1;
    stepBackBtn.disabled = !hasSession || historyIndex <= 0;
    if (!hasSession) {
      stepBtn.disabled = true;
      runBtn.disabled = true;
      return;
    }
    if (!atHistoryEnd) {
      stepBtn.disabled = false;
      stepBtn.textContent = "Step";
      runBtn.disabled = true;
    }
  }

  function stopAssembleSpinner() {
    if (assembleTimer !== null) {
      window.clearInterval(assembleTimer);
      assembleTimer = null;
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
    syncHistoryControls();
  }

  function renderFromHistory(index: number) {
    resetMemoryView();
    lastPc = undefined;
    for (let i = 0; i < index; i++) {
      memoryView.applyEffects(history[i].effects ?? []);
    }
    renderAll(history[index]);
  }

  const samplePrograms: Record<string, string> = {
    arraySum: [
      "# Sample: sum 4 sensor readings",
      "addi x1, x0, 64       # base address",
      "addi x2, x0, 10",
      "addi x3, x0, 20",
      "addi x4, x0, 30",
      "addi x5, x0, 40",
      "sw   x2, 0(x1)",
      "sw   x3, 4(x1)",
      "sw   x4, 8(x1)",
      "sw   x5, 12(x1)",
      "addi x6, x0, 0        # i",
      "addi x7, x0, 0        # sum",
      "loop:",
      "slti x8, x6, 4        # i < 4 ?",
      "beq  x8, x0, done",
      "slli x9, x6, 2        # byte offset",
      "add  x10, x1, x9",
      "lw   x11, 0(x10)",
      "add  x7, x7, x11",
      "addi x6, x6, 1",
      "beq  x0, x0, loop",
      "done:",
      "beq x0, x0, done",
    ].join("\n"),
    stringLength: [
      "# Sample: string length (null-terminated)",
      "addi x1, x0, 128      # base address",
      "addi x2, x0, 0x48     # 'H'",
      "sb   x2, 0(x1)",
      "addi x2, x0, 0x69     # 'i'",
      "sb   x2, 1(x1)",
      "addi x2, x0, 0x21     # '!'",
      "sb   x2, 2(x1)",
      "sb   x0, 3(x1)        # null terminator",
      "addi x3, x0, 0        # len",
      "loop:",
      "lb   x4, 0(x1)",
      "beq  x4, x0, done",
      "addi x3, x3, 1",
      "addi x1, x1, 1",
      "beq  x0, x0, loop",
      "done:",
      "beq x0, x0, done",
    ].join("\n"),
    memoryCopy: [
      "# Sample: memcpy 3 words",
      "addi x1, x0, 200      # src",
      "addi x2, x0, 300      # dst",
      "addi x3, x0, 0x1111",
      "sw   x3, 0(x1)",
      "addi x3, x0, 0x2222",
      "sw   x3, 4(x1)",
      "addi x3, x0, 0x3333",
      "sw   x3, 8(x1)",
      "addi x4, x0, 0        # i",
      "loop:",
      "slti x5, x4, 3",
      "beq  x5, x0, done",
      "slli x6, x4, 2",
      "add  x7, x1, x6",
      "add  x8, x2, x6",
      "lw   x9, 0(x7)",
      "sw   x9, 0(x8)",
      "addi x4, x4, 1",
      "beq  x0, x0, loop",
      "done:",
      "beq x0, x0, done",
    ].join("\n"),
    functionCall: [
      "# Sample: function call to scale and add",
      "addi a0, x0, 6",
      "addi a1, x0, 7",
      "jal  ra, scale_add",
      "addi x5, a0, 0        # result copy",
      "halt:",
      "beq  x0, x0, halt",
      "scale_add:",
      "add  a0, a0, a1",
      "slli a0, a0, 1",
      "jalr x0, 0(ra)",
    ].join("\n"),
    tempConvert: [
      "# Sample: temperature conversion C -> F (F = C*9/5 + 32)",
      "addi a0, x0, 25       # C",
      "addi t0, x0, 9",
      "mul  t1, a0, t0",
      "addi t2, x0, 5",
      "div  t3, t1, t2",
      "addi a0, t3, 32       # F",
      "halt:",
      "beq  x0, x0, halt",
    ].join("\n"),
    checksum: [
      "# Sample: XOR checksum over 4 bytes",
      "addi x1, x0, 400",
      "addi x2, x0, 0x12",
      "sb   x2, 0(x1)",
      "addi x2, x0, 0x34",
      "sb   x2, 1(x1)",
      "addi x2, x0, 0x56",
      "sb   x2, 2(x1)",
      "addi x2, x0, 0x78",
      "sb   x2, 3(x1)",
      "addi x3, x0, 0        # i",
      "addi x4, x0, 0        # checksum",
      "loop:",
      "slti x5, x3, 4",
      "beq  x5, x0, done",
      "add  x6, x1, x3",
      "lbu  x7, 0(x6)",
      "xor  x4, x4, x7",
      "addi x3, x3, 1",
      "beq  x0, x0, loop",
      "done:",
      "beq x0, x0, done",
    ].join("\n"),
    syscall: [
      "# Sample: ecall with ID in a7 (a0-a6 are args)",
      "addi a0, x0, 42",
      "addi a1, x0, 7",
      "addi a2, x0, 3",
      "addi a7, x0, 103",
      "ecall",
    ].join("\n"),
  };

  const assembleMessages = [
    "Taking a calculated RISC",
    "Reducing complexity, one instruction at a time",
    "Keeping it RISC-y, not complicated",
    "Minimal instructions, maximum intent",
    "Less is more. That's the RISC",
    "Cutting the fat from your instruction set",
    "Decoding instructions, no shortcuts",
    "Fetching, decoding, executing. Repeat",
    "One pipeline stage at a time",
    "No microcode magic here",
    "Straight to the silicon mindset",
    "Designed simple, running fast",
    "Open instructions, open future",
    "No licensing drama detected",
    "Freedom at the ISA level",
    "Vendor-neutral, opinionated execution",
    "Instruction set kept intentionally small",
    "Architected to be understood",
    "Aligning registers",
    "Stalling pipeline (just kidding)",
    "Branch prediction feeling confident today",
    "Cache miss avoided. Hopefully",
    "All zeros, no undefined behavior",
    "Executing exactly what you wrote",
    "This is a RISC worth taking",
    "Complexity declined. Simplicity accepted",
    "Built to teach, not to confuse",
    "You control the ISA here",
    "Understanding hardware, not memorizing it",
  ];

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
    history = [];
    historyIndex = -1;
    stopRun();
    stopAssembleSpinner();
    assembleBtn.disabled = false;
    stepBtn.disabled = true;
    stepBtn.textContent = "Step";
    runBtn.disabled = true;
    stepBackBtn.disabled = true;
    sourceEl.focus();
  }

  sampleSelect.onchange = () => {
    loadSample(sampleSelect.value || "arraySum");
  };

  // Load default sample on first render
  loadSample(sampleSelect.value || "arraySum");

  assembleBtn.onclick = async () => {
    stopAssembleSpinner();
    const baseMessage = assembleMessages[Math.floor(Math.random() * assembleMessages.length)].replace(
      /[.]+$/g,
      ""
    );
    let dots = 1;
    const renderAssembleStatus = () => {
      statusEl.textContent = `${baseMessage}${".".repeat(dots)}`;
      dots = dots === 3 ? 1 : dots + 1;
    };
    renderAssembleStatus();
    assembleTimer = window.setInterval(renderAssembleStatus, 500);

    stepBtn.disabled = true;
    stepBtn.textContent = "Step";
    runBtn.disabled = true;
    stopRun();

    try {
      const programText = sourceEl.value;
      const data = await apiClient.postJson("/api/session", { source: programText });
      sessionId = data.sessionId;
      resetMemoryView();
      setHistory(data);
      renderAll(data);
      stepBtn.disabled = !sessionId;
      runBtn.disabled = !sessionId;
    } catch (err) {
      effectsEl.textContent = `Error: ${(err as Error).message}`;
      sessionId = undefined;
      history = [];
      historyIndex = -1;
      statusEl.textContent = "";
      runBtn.disabled = true;
      stepBackBtn.disabled = true;
    } finally {
      stopAssembleSpinner();
    }
  };

  stepBackBtn.onclick = () => {
    if (!sessionId || historyIndex <= 0) {
      return;
    }
    stopRun();
    historyIndex -= 1;
    renderFromHistory(historyIndex);
  };

  stepBtn.onclick = async () => {
    if (!sessionId) {
      effectsEl.textContent = "Error: no sessionId. Click Assemble first.";
      return;
    }

    if (historyIndex < history.length - 1) {
      historyIndex += 1;
      renderFromHistory(historyIndex);
      return;
    }

    try {
      const data = await apiClient.postJson("/api/step", { sessionId });
      pushHistory(data);
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
    if (historyIndex < history.length - 1) {
      effectsEl.textContent = "Error: step forward to the latest state before running.";
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
