import { parseAssembly } from "./asm";
import "./auth-page";
import type { UserSession } from "./auth";
import { initAuthUi } from "./auth-ui";
import {
  animateFramePop,
  animateFramePush,
  animateSlotWrite,
  animateStep,
  resetAnimator,
  setAnimationsEnabled,
} from "./animator";
import { renderDisasm } from "./disasm";
import {
  escapeHtml,
  formatClikeExpression,
  fmtTrap,
  hex8,
  hex32,
  renderClikeExpression,
  renderRegs,
} from "./format";
import { DATA_BASE } from "./memory-map";
import { createMemoryView } from "./memory";
import { pushToUrl, readFromUrl } from "./permalink";
import { createProgramsUi, type ProgramsUiController } from "./programs-ui";
import { renderCallStack, setCallStackExplainer, setCallStackPlaceholder, syncCallStackUi } from "./stack-ui";
import { setStackLabelResolver, StackTracker, type CallStack, type StackFrame } from "./stack-tracker";
import type { ApiResponse, Effect, WasmStateDelta } from "./types";
import { WasmRuntime } from "./wasm-runtime";

let sessionId: string | undefined;
export let currentUserSession: UserSession | null = null;
const stackTracker = new StackTracker();

interface CurrentProgramState {
  programId: string | null;
  name: string | null;
  isDirty: boolean;
}

let currentProgram: CurrentProgramState = {
  programId: null,
  name: null,
  isDirty: false,
};

const MAX_RUN_STEPS = 2000;
const LOCAL_SIM_SESSION = "local-wasm";
const THEME_KEY = "studyriscv-theme";

type EffectLogFilters = {
  reg: boolean;
  mem: boolean;
  pc: boolean;
};

type EffectLogEntry =
  | { kind: "trap"; trap: NonNullable<ApiResponse["trap"]> }
  | { kind: "reg"; effect: Extract<Effect, { kind: "reg" }> }
  | { kind: "mem"; effect: Extract<Effect, { kind: "mem" }> }
  | { kind: "pc"; effect: Extract<Effect, { kind: "pc" }> };

type MemoryFollowMode = "none" | "sp" | "a0" | "a1" | "ra";

type StatusState = "ready" | "assembled" | "stepping" | "running" | "halted" | "trap";

const DEFAULT_EFFECT_FILTERS: EffectLogFilters = {
  reg: true,
  mem: true,
  pc: true,
};

const FOLLOW_REGISTER_MAP: Record<Exclude<MemoryFollowMode, "none">, number> = {
  sp: 2,
  a0: 10,
  a1: 11,
  ra: 1,
};

window.addEventListener("DOMContentLoaded", async () => {
  const assembleProgressEl = document.getElementById("assembleProgress") as HTMLElement | null;
  const assembleBtn = document.getElementById("assemble") as HTMLButtonElement;
  const stepBtn = document.getElementById("step") as HTMLButtonElement;
  const stepBackBtn = document.getElementById("stepBack") as HTMLButtonElement;
  const runBtn = document.getElementById("run") as HTMLButtonElement;
  const resetBtn = document.getElementById("reset") as HTMLButtonElement;
  const saveProgramBtn = document.getElementById("save-program-btn") as HTMLButtonElement | null;
  const saveProgramDirtyIndicator = document.getElementById("saveProgramDirtyIndicator") as HTMLElement | null;
  const shareSourceBtn = document.getElementById("shareSource") as HTMLButtonElement | null;
  const copySourceBtn = document.getElementById("copySource") as HTMLButtonElement | null;
  const copyToastEl = document.getElementById("copyToast") as HTMLElement | null;
  const sharedLinkBannerEl = document.getElementById("sharedLinkBanner") as HTMLElement | null;
  const dismissSharedBannerBtn = document.getElementById("dismissSharedBanner") as HTMLButtonElement | null;
  const sourceEl = document.getElementById("source-input") as HTMLTextAreaElement;
  const sourceLinesEl = document.getElementById("line-numbers") as HTMLElement | null;
  const highlightDisplayEl = document.getElementById("highlight-display") as HTMLElement | null;

  const clikeEl = document.getElementById("clike") as HTMLElement;
  const effectsEl = document.getElementById("effects") as HTMLElement;
  const effectFilterRegBtn = document.getElementById("effectFilterReg") as HTMLButtonElement | null;
  const effectFilterMemBtn = document.getElementById("effectFilterMem") as HTMLButtonElement | null;
  const effectFilterPcBtn = document.getElementById("effectFilterPc") as HTMLButtonElement | null;
  const regsEl = document.getElementById("regs") as HTMLElement;
  const pcEl = document.getElementById("pc") as HTMLElement;
  const disasmEl = document.getElementById("disasm") as HTMLElement;
  const memWritesEl = document.getElementById("memWrites") as HTMLElement;
  const memWindowEl = document.getElementById("memWindow") as HTMLElement;
  const memAddressInput = document.getElementById("memAddressInput") as HTMLInputElement | null;
  const memFollowSelect = document.getElementById("memFollowSelect") as HTMLSelectElement | null;
  const statusEl = document.getElementById("status") as HTMLElement;
  const statusBadgeEl = document.getElementById("statusBadge") as HTMLElement | null;
  const sampleSelect = document.getElementById("sampleSelect") as HTMLSelectElement;
  const themeToggle = document.getElementById("simThemeToggle") as HTMLButtonElement | null;
  const savedProgramsPanel = document.getElementById("savedProgramsPanel") as HTMLElement | null;
  const savedProgramsBody = document.getElementById("savedProgramsBody") as HTMLElement | null;
  const savedProgramsToggle = document.getElementById("savedProgramsToggle") as HTMLButtonElement | null;
  const historyPanel = document.getElementById("historyPanel") as HTMLElement | null;
  const historyBody = document.getElementById("historyBody") as HTMLElement | null;
  const historyToggle = document.getElementById("historyToggle") as HTMLButtonElement | null;

  const memoryView = createMemoryView();
  let lastPc: number | undefined;
  let assembleTimer: number | null = null;
  let history: ApiResponse[] = [];
  let historyIndex = -1;
  let disasmLines: ApiResponse["disasm"] = [];
  let clikeByPc = new Map<number, string>();
  let disasmEncodings = new Map<number, string>();
  let runtime: WasmRuntime | null = null;
  let programsUi: ProgramsUiController | null = null;
  let copyToastTimer: number | null = null;
  let assembleProgressStartedAt = 0;
  let assembleProgressResetTimer: number | null = null;
  let programDataBytes = new Uint8Array();
  let manualMemoryBase = 0;
  let memoryFollowMode: MemoryFollowMode = "none";
  let effectFilters: EffectLogFilters = { ...DEFAULT_EFFECT_FILTERS };
  let memoryInputInvalidTimer: number | null = null;
  const sampleOptionLabels = new Map<string, string>(
    Array.from(sampleSelect.options).map((option) => [option.value, option.textContent ?? option.value])
  );
  const asmMnemonics = new Set([
    "add",
    "addi",
    "sub",
    "and",
    "andi",
    "or",
    "ori",
    "xor",
    "xori",
    "sll",
    "slli",
    "srl",
    "srli",
    "sra",
    "srai",
    "slt",
    "slti",
    "sltu",
    "sltiu",
    "mul",
    "mulh",
    "mulhu",
    "mulhsu",
    "div",
    "divu",
    "rem",
    "remu",
    "lui",
    "auipc",
    "jal",
    "jalr",
    "beq",
    "bne",
    "blt",
    "bge",
    "bltu",
    "bgeu",
    "lw",
    "lh",
    "lb",
    "lhu",
    "lbu",
    "sw",
    "sh",
    "sb",
    "li",
    "mv",
    "nop",
    "j",
    "ret",
    "call",
    "la",
    "ecall",
    "ebreak",
  ]);
  const asmRegisters = new Set([
    "zero",
    "ra",
    "sp",
    "gp",
    "tp",
    "t0",
    "t1",
    "t2",
    "t3",
    "t4",
    "t5",
    "t6",
    "s0",
    "s1",
    "s2",
    "s3",
    "s4",
    "s5",
    "s6",
    "s7",
    "s8",
    "s9",
    "s10",
    "s11",
    "a0",
    "a1",
    "a2",
    "a3",
    "a4",
    "a5",
    "a6",
    "a7",
    "fp",
    ...Array.from({ length: 32 }, (_, index) => `x${index}`),
  ]);
  const asmTokenPattern =
    /(?:-?0x[0-9a-fA-F]+|-?\d+|\bx(?:[0-9]|[12][0-9]|3[01])\b|\b(?:zero|ra|sp|gp|tp|t[0-6]|s(?:[0-9]|1[01])|a[0-7]|fp)\b|\b[A-Za-z_.$][\w.$]*\b)/g;
  const asmLabelPattern = /^\s*([A-Za-z_.$][\w.$]*):/;

  function applyThemeIcon() {
    if (!themeToggle) return;
    const isDark = document.documentElement.dataset.theme === "dark";
    themeToggle.setAttribute("aria-pressed", String(isDark));
    themeToggle.setAttribute("aria-label", isDark ? "Switch to light mode" : "Switch to dark mode");
  }

  function syncHighlightScroll() {
    if (!highlightDisplayEl) return;
    highlightDisplayEl.scrollTop = sourceEl.scrollTop;
    highlightDisplayEl.scrollLeft = sourceEl.scrollLeft;
  }

  function highlightToken(token: string, labels: ReadonlySet<string>): string {
    const lower = token.toLowerCase();
    if (asmRegisters.has(lower)) {
      return `<span class="asm-register">${escapeHtml(token)}</span>`;
    }
    if (/^-?(?:0x[0-9a-fA-F]+|\d+)$/.test(token)) {
      return `<span class="asm-immediate">${escapeHtml(token)}</span>`;
    }
    if (labels.has(token)) {
      return `<span class="asm-label-ref">${escapeHtml(token)}</span>`;
    }
    return escapeHtml(token);
  }

  function highlightTrailingSegment(segment: string, labels: ReadonlySet<string>): string {
    if (!segment) return "";
    let html = "";
    let lastIndex = 0;
    asmTokenPattern.lastIndex = 0;

    for (const match of segment.matchAll(asmTokenPattern)) {
      const index = match.index ?? 0;
      const token = match[0];
      html += escapeHtml(segment.slice(lastIndex, index));
      html += highlightToken(token, labels);
      lastIndex = index + token.length;
    }

    html += escapeHtml(segment.slice(lastIndex));
    return html;
  }

  function highlightCodeSegment(line: string, labels: ReadonlySet<string>): string {
    if (!line) return "";

    let remainder = line;
    let highlighted = "";
    const labelMatch = remainder.match(asmLabelPattern);

    if (labelMatch) {
      const [fullMatch, labelName] = labelMatch;
      const prefixLength = fullMatch.indexOf(labelName);
      const suffixStart = prefixLength + labelName.length + 1;
      highlighted += escapeHtml(fullMatch.slice(0, prefixLength));
      highlighted += `<span class="asm-label">${escapeHtml(`${labelName}:`)}</span>`;
      highlighted += escapeHtml(fullMatch.slice(suffixStart));
      remainder = remainder.slice(fullMatch.length);
    }

    const instructionMatch = remainder.match(/^(\s*)(\S+)([\s\S]*)$/);
    if (!instructionMatch) {
      return highlighted + escapeHtml(remainder);
    }

    const [, leadingWhitespace, firstToken, rest] = instructionMatch;
    highlighted += escapeHtml(leadingWhitespace);
    if (asmMnemonics.has(firstToken.toLowerCase())) {
      highlighted += `<span class="asm-mnemonic">${escapeHtml(firstToken)}</span>`;
    } else {
      highlighted += highlightToken(firstToken, labels);
    }
    highlighted += highlightTrailingSegment(rest, labels);
    return highlighted;
  }

  function highlightAssembly(source: string): string {
    const lines = source.split("\n");
    const labels = new Set<string>();

    for (const line of lines) {
      const labelMatch = line.match(asmLabelPattern);
      if (labelMatch) {
        labels.add(labelMatch[1]);
      }
    }

    return lines
      .map((line) => {
        if (/^\s*#/.test(line)) {
          return `<span class="asm-comment">${escapeHtml(line)}</span>`;
        }

        const commentIndex = line.indexOf("#");
        if (commentIndex < 0) {
          return highlightCodeSegment(line, labels);
        }

        const code = line.slice(0, commentIndex);
        const comment = line.slice(commentIndex);
        return `${highlightCodeSegment(code, labels)}<span class="asm-comment">${escapeHtml(comment)}</span>`;
      })
      .join("\n");
  }

  function renderHighlightedSource() {
    if (!highlightDisplayEl) return;
    highlightDisplayEl.innerHTML = highlightAssembly(sourceEl.value);
    syncHighlightScroll();
  }

  function updateLineNumbers() {
    if (!sourceLinesEl) return;
    const lines = sourceEl.value.split("\n");
    const lineCount = Math.max(10, lines.length);
    const currentLine = sourceEl.value.substring(0, sourceEl.selectionStart).split("\n").length;

    sourceLinesEl.innerHTML = Array.from({ length: lineCount }, (_, index) => {
      const lineNumber = index + 1;
      const currentLineClass = lineNumber === currentLine ? ' class="current-line"' : "";
      const label = lineNumber <= lines.length ? String(lineNumber) : "";
      return `<span${currentLineClass}>${label}</span>`;
    }).join("");

    sourceLinesEl.scrollTop = sourceEl.scrollTop;
  }

  function handleSourceInput() {
    renderHighlightedSource();
    updateLineNumbers();
    if (!currentProgram.isDirty) {
      updateCurrentProgramState({ isDirty: true });
    }
  }

  function insertTextAtSelection(text: string) {
    const start = sourceEl.selectionStart;
    const end = sourceEl.selectionEnd;
    sourceEl.setRangeText(text, start, end, "end");
    handleSourceInput();
  }

  function syncSampleOptionLabels(selectedName: string) {
    for (const option of Array.from(sampleSelect.options)) {
      const baseLabel = sampleOptionLabels.get(option.value) ?? option.value;
      option.textContent = option.value === selectedName ? `✓ ${baseLabel}` : baseLabel;
    }
  }

  function syncCurrentProgramUi() {
    programsUi?.setCurrentProgram(currentProgram);
  }

  function setCurrentProgramState(nextState: CurrentProgramState) {
    currentProgram = nextState;
    syncCurrentProgramUi();
  }

  function updateCurrentProgramState(nextState: Partial<CurrentProgramState>) {
    currentProgram = { ...currentProgram, ...nextState };
    syncCurrentProgramUi();
  }

  function resetCurrentProgramState() {
    setCurrentProgramState({
      programId: null,
      name: null,
      isDirty: false,
    });
  }

  function setStatus(state: StatusState, label?: string) {
    if (!statusBadgeEl) return;
    statusBadgeEl.className = `status-badge status-badge--${state}`;
    statusBadgeEl.textContent =
      label ??
      {
        ready: "Ready",
        assembled: "Assembled",
        stepping: "Stepping",
        running: "Running",
        halted: "Halted",
        trap: "Trap",
      }[state];
  }

  function trapStatusLabel(trap: NonNullable<ApiResponse["trap"]>): string {
    switch (trap.cause) {
      case "environment_call":
        return "TRAP ecall";
      case "breakpoint":
        return "TRAP ebreak";
      default:
        if (trap.cause.includes("misaligned")) {
          return "TRAP align";
        }
        return `TRAP ${trap.cause.replace(/_/g, " ")}`;
    }
  }

  function alignMemoryBase(address: number): number {
    return (address >>> 0) & ~0x7;
  }

  function currentSnapshot(): ApiResponse | undefined {
    return historyIndex >= 0 ? history[historyIndex] : undefined;
  }

  function normalizeDisasmLabel(labelText: string): string {
    return labelText.replace(/:\s*$/, "").trim();
  }

  function buildStackLabelContext(disasm: ApiResponse["disasm"]): {
    resolve: (pc: number) => string | undefined;
    firstLabel: string;
  } {
    const labelsByPc = new Map<number, string>();
    let activeLabel: string | undefined;
    let firstLabel = "main";

    for (const line of disasm ?? []) {
      if (line.label) {
        const label = normalizeDisasmLabel(line.text);
        if (label) {
          if (firstLabel === "main") {
            firstLabel = label;
          }
          activeLabel = label;
        }
        continue;
      }

      if (activeLabel) {
        labelsByPc.set(line.pc >>> 0, activeLabel);
      }
    }

    return {
      resolve(pc: number) {
        return labelsByPc.get(pc >>> 0);
      },
      firstLabel,
    };
  }

  function snapshotToDelta(snapshot: ApiResponse): WasmStateDelta {
    return {
      pc: snapshot.pc ?? 0,
      halted: snapshot.halted === true,
      trap: snapshot.trap ?? null,
      effects: snapshot.effects ?? [],
    };
  }

  function currentStackFrame(callStack: CallStack): StackFrame | undefined {
    return callStack.frames[callStack.frames.length - 1];
  }

  function frameSlotValues(frame?: StackFrame): Map<number, number> {
    const values = new Map<number, number>();
    if (!frame) {
      return values;
    }

    for (const saved of frame.savedRegisters) {
      values.set(saved.address >>> 0, saved.value >>> 0);
    }
    for (const slot of frame.localSlots) {
      values.set(slot.address >>> 0, slot.value >>> 0);
    }

    return values;
  }

  function collectCurrentFrameWrites(before: CallStack, after: CallStack): Array<{ address: number; value: number }> {
    const current = currentStackFrame(after);
    if (!current) {
      return [];
    }

    const previousFrame = before.frames.find(
      (frame) =>
        frame.entryPc === current.entryPc &&
        frame.baseAddress === current.baseAddress &&
        frame.returnAddress === current.returnAddress
    );
    const previousValues = frameSlotValues(previousFrame);
    const currentValues = frameSlotValues(current);
    const writes: Array<{ address: number; value: number }> = [];

    for (const [address, value] of currentValues) {
      if (!previousValues.has(address) || previousValues.get(address) !== value) {
        writes.push({ address, value });
      }
    }

    return writes.sort((left, right) => right.address - left.address);
  }

  function buildSavedRegisterExplainer(frame?: StackFrame): string | null {
    if (!frame || frame.savedRegisters.length === 0) {
      return null;
    }

    return frame.savedRegisters
      .slice(0, 2)
      .map((saved) => `${saved.name} saved at ${hex32(saved.address)}.`)
      .join(" ");
  }

  function buildCallStackExplainer(before: CallStack, after: CallStack): string {
    if (after.frames.length < before.frames.length) {
      return "Restoring saved registers. Returning to ra.";
    }

    const current = currentStackFrame(after);
    const savedRegisterNarration = buildSavedRegisterExplainer(current);
    if (savedRegisterNarration) {
      return savedRegisterNarration;
    }

    if (after.frames.length > before.frames.length && current) {
      return `Entered ${current.functionLabel}. Watch the frame build downward.`;
    }

    if (!current) {
      return "Step into a function to see the calling convention.";
    }

    return `Current frame: ${current.functionLabel}. Watch where sp moves next.`;
  }

  function resolveMemoryWindowBase(regs?: number[]): number {
    if (memoryFollowMode === "none") {
      return manualMemoryBase;
    }

    const registerIndex = FOLLOW_REGISTER_MAP[memoryFollowMode];
    const registerValue = regs?.[registerIndex] ?? manualMemoryBase;
    return alignMemoryBase(registerValue);
  }

  function syncMemoryControls(regs?: number[]) {
    if (!memAddressInput || !memFollowSelect) {
      return;
    }

    const base = resolveMemoryWindowBase(regs);
    const readonly = memoryFollowMode !== "none";
    memAddressInput.readOnly = readonly;
    memAddressInput.classList.toggle("memory-address-input--readonly", readonly);
    memFollowSelect.value = memoryFollowMode;

    if (readonly || document.activeElement !== memAddressInput) {
      memAddressInput.value = hex32(base);
    }
  }

  function updateMemoryWindow(regs?: number[]) {
    const base = resolveMemoryWindowBase(regs);
    memWindowEl.innerHTML = memoryView.renderWindow(base);
    syncMemoryControls(regs);
  }

  function resetMemoryControls(base = 0) {
    memoryFollowMode = "none";
    manualMemoryBase = alignMemoryBase(base);
    syncMemoryControls(currentSnapshot()?.regs);
  }

  function flashMemoryInputInvalid() {
    if (!memAddressInput) return;
    if (memoryInputInvalidTimer !== null) {
      window.clearTimeout(memoryInputInvalidTimer);
    }
    memAddressInput.classList.add("memory-address-input--invalid");
    memoryInputInvalidTimer = window.setTimeout(() => {
      memAddressInput.classList.remove("memory-address-input--invalid");
      memoryInputInvalidTimer = null;
    }, 400);
  }

  function commitMemoryAddressInput() {
    if (!memAddressInput || memoryFollowMode !== "none") {
      syncMemoryControls(currentSnapshot()?.regs);
      return;
    }

    const raw = memAddressInput.value.trim();
    const normalized = raw.startsWith("0x") || raw.startsWith("0X") ? raw.slice(2) : raw;
    if (!/^[0-9a-fA-F]+$/.test(normalized)) {
      flashMemoryInputInvalid();
      syncMemoryControls(currentSnapshot()?.regs);
      return;
    }

    const parsed = Number.parseInt(normalized, 16);
    if (!Number.isFinite(parsed)) {
      flashMemoryInputInvalid();
      syncMemoryControls(currentSnapshot()?.regs);
      return;
    }

    manualMemoryBase = alignMemoryBase(parsed);
    updateMemoryWindow(currentSnapshot()?.regs);
  }

  function resetEffectFilters() {
    effectFilters = { ...DEFAULT_EFFECT_FILTERS };
    updateEffectFilterButtons();
  }

  function updateEffectFilterButtons() {
    const buttons: Array<[HTMLButtonElement | null, keyof EffectLogFilters]> = [
      [effectFilterRegBtn, "reg"],
      [effectFilterMemBtn, "mem"],
      [effectFilterPcBtn, "pc"],
    ];

    for (const [button, key] of buttons) {
      if (!button) continue;
      const active = effectFilters[key];
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    }
  }

  function filterLog(entries: EffectLogEntry[], filters: EffectLogFilters): EffectLogEntry[] {
    return entries.filter((entry) => {
      if (entry.kind === "trap") {
        return true;
      }
      return filters[entry.kind];
    });
  }

  function setSharedBannerVisible(visible: boolean) {
    if (!sharedLinkBannerEl) return;
    sharedLinkBannerEl.hidden = !visible;
    sharedLinkBannerEl.style.display = visible ? "flex" : "none";
  }

  function clearSharedLinkHash() {
    if (typeof window === "undefined") {
      return;
    }
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  }

  function startAssembleProgress() {
    if (!assembleProgressEl) return;
    if (assembleProgressResetTimer !== null) {
      window.clearTimeout(assembleProgressResetTimer);
      assembleProgressResetTimer = null;
    }
    assembleProgressStartedAt = performance.now();
    assembleProgressEl.classList.remove("assembling");
    void assembleProgressEl.offsetWidth;
    assembleProgressEl.classList.add("assembling");
  }

  function stopAssembleProgress() {
    if (!assembleProgressEl) return;
    const elapsed = performance.now() - assembleProgressStartedAt;
    const remaining = Math.max(0, 400 - elapsed);
    assembleProgressResetTimer = window.setTimeout(() => {
      assembleProgressEl.classList.remove("assembling");
      assembleProgressResetTimer = null;
    }, remaining);
  }

  function showToast(message = "Copied!") {
    if (!copyToastEl) return;
    copyToastEl.textContent = message;
    if (copyToastTimer !== null) {
      window.clearTimeout(copyToastTimer);
    }
    copyToastEl.classList.remove("is-visible");
    void copyToastEl.offsetWidth;
    copyToastEl.classList.add("is-visible");
    copyToastTimer = window.setTimeout(() => {
      copyToastEl.classList.remove("is-visible");
      copyToastTimer = null;
    }, 1650);
  }

  async function copyTextToClipboard(text: string, toastMessage = "Copied!") {
    if (!text.trim()) {
      return;
    }
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const tempEl = document.createElement("textarea");
        tempEl.value = text;
        tempEl.setAttribute("readonly", "true");
        tempEl.style.position = "absolute";
        tempEl.style.left = "-9999px";
        document.body.appendChild(tempEl);
        tempEl.select();
        document.execCommand("copy");
        document.body.removeChild(tempEl);
      }
      showToast(toastMessage);
    } catch {
      setPanelMessage(effectsEl, "Copy failed. Your browser blocked clipboard access.", "danger");
    }
  }

  async function copySourceToClipboard() {
    await copyTextToClipboard(sourceEl.value, "Copied!");
  }

  function effectEmptyState(): string {
    return `
      <div class="effect-empty">
        <div class="effect-empty__example">x5  0x00000000 → 0x0000000C</div>
        <div class="effect-empty__note">Effects will appear here as you step.</div>
      </div>
    `;
  }

  function setPanelMessage(element: HTMLElement, message: string, variant: "default" | "danger" = "default") {
    const classes = ["empty-state"];
    if (variant === "danger") {
      classes.push("empty-state--danger");
    }
    element.innerHTML = `<div class="${classes.join(" ")}">${escapeHtml(message)}</div>`;
  }

  function resetMemoryView() {
    memoryView.reset();
    if (programDataBytes.length > 0) {
      memoryView.seedBytes(DATA_BASE, programDataBytes);
    }
    lastPc = undefined;
    setPanelMessage(memWritesEl, "No memory writes yet.");
    updateMemoryWindow(currentSnapshot()?.regs);
  }

  function clearPanels() {
    clikeEl.innerHTML = renderClikeExpression(null);
    effectsEl.innerHTML = effectEmptyState();
    regsEl.innerHTML = renderRegs();
    pcEl.textContent = "";
    disasmEl.innerHTML = renderDisasm(undefined, undefined, []);
    resetMemoryView();
    stackTracker.reset();
    setCallStackExplainer("Step into a function to see the calling convention.");
    syncCallStackUi(stackTracker.getCallStack());
    resetAnimator();
  }

  function stopRun(message?: string) {
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

  function syncStackTrackerToHistory(index: number) {
    stackTracker.reset();
    for (let i = 1; i <= index; i++) {
      stackTracker.applyDelta(snapshotToDelta(history[i]));
    }
  }

  function syncHistoryControls() {
    const hasSession = Boolean(sessionId);
    const atHistoryEnd = historyIndex >= history.length - 1;
    stepBackBtn.disabled = !hasSession || historyIndex <= 0;
    resetBtn.disabled = !hasSession;
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
    const pcEffect = effects.find((effect) => effect.kind === "pc");
    if (pcEffect) {
      lastPc = pcEffect.before;
    }
  }

  function isPcStalled(effects: Effect[]): boolean {
    const pcEffect = effects.find((effect) => effect.kind === "pc");
    return pcEffect ? pcEffect.before === pcEffect.after : false;
  }

  function translateRiscvToClike(instText: string): string {
    const normalized = instText.trim().replace(/\s+/g, " ");
    const tokens = normalized.replace(/,/g, " ").split(/\s+/);
    const op = (tokens[0] || "").toLowerCase();
    const a = tokens[1];
    const b = tokens[2];
    const c = tokens[3];

    const binOp = (symbol: string) => `${a} = ${b} ${symbol} ${c};`;
    const immOp = (symbol: string) => `${a} = ${b} ${symbol} ${c};`;

    if (op === "addi") return immOp("+");
    if (op === "add") return binOp("+");
    if (op === "sub") return binOp("-");
    if (op === "and") return binOp("&");
    if (op === "or") return binOp("|");
    if (op === "xor") return binOp("^");
    if (op === "sll") return binOp("<<");
    if (op === "srl") return `${a} = ((unsigned)${b}) >> ${c};`;
    if (op === "sra") return `${a} = ((int)${b}) >> ${c};`;
    if (op === "mul") return binOp("*");
    if (op === "div") return `${a} = ((int)${b}) / ((int)${c});`;
    if (op === "divu") return `${a} = ${b} / ${c};`;
    if (op === "rem") return `${a} = ((int)${b}) % ((int)${c});`;
    if (op === "remu") return `${a} = ${b} % ${c};`;
    if (op === "slti") return `${a} = ((int)${b} < ${c}) ? 1 : 0;`;
    if (op === "slt") return `${a} = ((int)${b} < (int)${c}) ? 1 : 0;`;
    if (op === "sltu") return `${a} = (${b} < ${c}) ? 1 : 0;`;

    const loadMatch = normalized.match(/^(\w+)\s+(\w+)\s*,\s*([^)]+)\((\w+)\)$/i);
    if (loadMatch) {
      const loadOp = loadMatch[1].toLowerCase();
      const rd = loadMatch[2];
      const imm = loadMatch[3];
      const rs1 = loadMatch[4];
      if (loadOp === "lw") return `${rd} = *(u32*)(${rs1} + ${imm});`;
      if (loadOp === "lh") return `${rd} = *(i16*)(${rs1} + ${imm});`;
      if (loadOp === "lhu") return `${rd} = *(u16*)(${rs1} + ${imm});`;
      if (loadOp === "lb") return `${rd} = *(i8*)(${rs1} + ${imm});`;
      if (loadOp === "lbu") return `${rd} = *(u8*)(${rs1} + ${imm});`;
      if (loadOp === "jalr") return `tmp = pc + 4; pc = (${rs1} + ${imm}) & ~1; ${rd} = tmp;`;
    }

    const storeMatch = normalized.match(/^(\w+)\s+(\w+)\s*,\s*([^)]+)\((\w+)\)$/i);
    if (storeMatch) {
      const storeOp = storeMatch[1].toLowerCase();
      const rs2 = storeMatch[2];
      const imm = storeMatch[3];
      const rs1 = storeMatch[4];
      if (storeOp === "sw") return `*(u32*)(${rs1} + ${imm}) = ${rs2};`;
      if (storeOp === "sh") return `*(u16*)(${rs1} + ${imm}) = ${rs2};`;
      if (storeOp === "sb") return `*(u8*)(${rs1} + ${imm}) = ${rs2};`;
    }

    if (op === "beq") return `if (${a} == ${b}) pc = ${c}; else pc += 4;`;
    if (op === "bne") return `if (${a} != ${b}) pc = ${c}; else pc += 4;`;
    if (op === "blt") return `if ((int)${a} < (int)${b}) pc = ${c}; else pc += 4;`;
    if (op === "bge") return `if ((int)${a} >= (int)${b}) pc = ${c}; else pc += 4;`;
    if (op === "bltu") return `if (${a} < ${b}) pc = ${c}; else pc += 4;`;
    if (op === "bgeu") return `if (${a} >= ${b}) pc = ${c}; else pc += 4;`;
    if (op === "jal") return `tmp = pc + 4; pc = ${c ?? b}; ${a ?? "x1"} = tmp;`;
    if (op === "lui") return `${a} = ${b} << 12;`;
    if (op === "auipc") return `${a} = pc + (${b} << 12);`;
    if (op === "ecall") return "trap_ecall();";

    return normalized;
  }

  function buildClikeMap(disasm: ApiResponse["disasm"]): Map<number, string> {
    const map = new Map<number, string>();
    for (const line of disasm ?? []) {
      if (!line.label) {
        map.set(line.pc, translateRiscvToClike(line.text));
      }
    }
    return map;
  }

  function currentClikeForPc(pc: number | undefined): string {
    if (pc !== undefined && clikeByPc.has(pc)) {
      return clikeByPc.get(pc) ?? "";
    }
    const first = clikeByPc.values().next();
    return first.done ? "" : first.value;
  }

  function buildDisasmEncodings(lines: ApiResponse["disasm"]): Map<number, string> {
    const encodings = new Map<number, string>();
    if (!runtime) return encodings;

    for (const line of lines ?? []) {
      if (line.label) continue;
      const bytes = runtime.memorySlice(line.pc, 4);
      if (bytes.length !== 4) continue;
      const word = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
      encodings.set(line.pc, word.toString(16).padStart(8, "0"));
    }

    return encodings;
  }

  function buildSnapshot(delta?: WasmStateDelta): ApiResponse {
    if (!runtime) {
      throw new Error("WASM simulator not initialized.");
    }
    const pc = delta?.pc ?? runtime.pc();
    return {
      sessionId: LOCAL_SIM_SESSION,
      pc,
      regs: runtime.readRegisters(),
      halted: delta?.halted ?? false,
      effects: delta?.effects ?? [],
      trap: delta?.trap ?? null,
      clike: currentClikeForPc(pc),
      rv2c: "",
      disasm: disasmLines,
    };
  }

  function collectChangedRegs(effects: Effect[]): Set<number> {
    const registers = new Set<number>();
    for (const effect of effects) {
      if (effect.kind === "reg") {
        registers.add(effect.reg);
      }
    }
    return registers;
  }

  function effectEntryClasses(baseClass: string, isLatest: boolean): string {
    return isLatest ? `${baseClass} effect-entry--latest` : baseClass;
  }

  function renderEffectEntry(effect: Effect, isLatest: boolean): string {
    switch (effect.kind) {
      case "reg":
        return `
          <div class="${effectEntryClasses("effect-entry effect-entry--reg", isLatest)}">
            <span class="effect-entry__label">x${effect.reg}</span>
            <span class="effect-entry__before">${hex32(effect.before)}</span>
            <span class="effect-entry__arrow">→</span>
            <span class="effect-entry__after">${hex32(effect.after)}</span>
          </div>
        `;
      case "mem":
        return `
          <div class="${effectEntryClasses("effect-entry effect-entry--mem", isLatest)}">
            <span class="effect-entry__label effect-entry__label--mem">${hex32(effect.addr)}</span>
            <span class="effect-entry__before">0x${hex8(effect.before)}</span>
            <span class="effect-entry__arrow">→</span>
            <span class="effect-entry__after">0x${hex8(effect.after)}</span>
          </div>
        `;
      case "pc":
        return `
          <div class="${effectEntryClasses("effect-entry effect-entry--pc", isLatest)}">
            <span class="effect-entry__label">PC</span>
            <span class="effect-entry__before">${hex32(effect.before)}</span>
            <span class="effect-entry__arrow">→</span>
            <span class="effect-entry__after">${hex32(effect.after)}</span>
          </div>
        `;
    }
  }

  function buildEffectEntries(): EffectLogEntry[] {
    const entries: EffectLogEntry[] = [];

    for (let index = historyIndex; index >= 0 && entries.length < 32; index--) {
      const snapshot = history[index];
      if (snapshot.trap) {
        entries.push({ kind: "trap", trap: snapshot.trap });
      }
      const effects = [...(snapshot.effects ?? [])].reverse();
      for (const effect of effects) {
        if (entries.length >= 32) break;
        if (effect.kind === "reg") {
          entries.push({ kind: "reg", effect });
        } else if (effect.kind === "mem") {
          entries.push({ kind: "mem", effect });
        } else {
          entries.push({ kind: "pc", effect });
        }
      }
    }

    return entries;
  }

  function renderEffectLog(): string {
    const entries = filterLog(buildEffectEntries(), effectFilters);
    if (entries.length === 0) {
      return historyIndex >= 0
        ? '<div class="empty-state">No effect entries match the current filters.</div>'
        : effectEmptyState();
    }

    return entries
      .map((entry, index) => {
        if (entry.kind === "trap") {
          return `<div class="${effectEntryClasses("effect-entry effect-entry--trap", index === 0)}"><span class="effect-entry__trap">${escapeHtml(fmtTrap(entry.trap))}</span></div>`;
        }
        return renderEffectEntry(entry.effect, index === 0);
      })
      .join("");
  }

  function renderAll(data: ApiResponse) {
    const effects = data.effects ?? [];
    memoryView.applyEffects(effects);
    updateLastPc(effects);

    const previousEffects = historyIndex > 0 ? history[historyIndex - 1].effects ?? [] : [];
    const clikeExpression = data.clike && data.clike.trim().length > 0 ? data.clike : data.rv2c ?? "";
    clikeEl.innerHTML = renderClikeExpression(formatClikeExpression(clikeExpression));
    effectsEl.innerHTML = renderEffectLog();
    regsEl.innerHTML = renderRegs(data.regs, collectChangedRegs(effects), collectChangedRegs(previousEffects));
    pcEl.textContent = data.pc !== undefined ? hex32(data.pc) : "";
    disasmEl.innerHTML = renderDisasm(data.pc, lastPc, data.disasm, disasmEncodings);

    const recentWrites = memoryView.getRecentWrites();
    memWritesEl.innerHTML = recentWrites.length
      ? recentWrites
          .map((write) => `<div class="memory-write-item">${escapeHtml(write)}</div>`)
          .join("")
      : '<div class="empty-state">No memory writes yet.</div>';

    updateMemoryWindow(data.regs);

    const halted = data.halted === true;
    const stalled = isPcStalled(effects);
    if (data.trap) {
      stepBtn.disabled = true;
      stepBtn.textContent = "Trapped";
      runBtn.disabled = true;
      assembleBtn.disabled = false;
      setStatus("trap", trapStatusLabel(data.trap));
    } else if (halted || stalled) {
      stepBtn.disabled = true;
      stepBtn.textContent = "Halted";
      stopRun(stalled && !halted ? "Halt loop detected." : "Program halted.");
      statusEl.textContent = stalled && !halted ? "Halt loop detected." : "Program halted.";
      assembleBtn.disabled = false;
      setStatus("halted");
    } else {
      stepBtn.textContent = "Step";
    }
    runBtn.disabled = !sessionId || halted || stalled || Boolean(data.trap);
    syncHistoryControls();
  }

  function renderFromHistory(index: number, syncStack = true) {
    resetMemoryView();
    lastPc = undefined;
    for (let i = 0; i < index; i++) {
      memoryView.applyEffects(history[i].effects ?? []);
    }
    renderAll(history[index]);
    if (syncStack) {
      syncStackTrackerToHistory(index);
    }
    const callStack = stackTracker.getCallStack();
    setCallStackExplainer(buildCallStackExplainer(callStack, callStack));
    syncCallStackUi(callStack);
  }

  async function assembleCurrentSource(showSpinner: boolean, successMessage: string): Promise<boolean> {
    if (!runtime) {
      setPanelMessage(effectsEl, "WASM module not initialized yet.", "danger");
      return false;
    }

    let succeeded = false;
    resetEffectFilters();
    stopAssembleSpinner();
    if (showSpinner) {
      startAssembleProgress();
    }
    if (showSpinner) {
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
    } else {
      statusEl.textContent = "Resetting program…";
    }

    stepBtn.disabled = true;
    stepBtn.textContent = "Step";
    runBtn.disabled = true;
    stopRun();

    try {
      const parsed = parseAssembly(sourceEl.value);
      disasmLines = parsed.disasm;
      const stackLabels = buildStackLabelContext(disasmLines);
      setStackLabelResolver(stackLabels.resolve, stackLabels.firstLabel);
      setCallStackPlaceholder(stackLabels.firstLabel);
      clikeByPc = buildClikeMap(disasmLines);
      programDataBytes = parsed.data instanceof Uint8Array ? Uint8Array.from(parsed.data) : new Uint8Array();
      resetMemoryControls(programDataBytes.length > 0 ? DATA_BASE : 0);
      runtime.loadProgram(parsed.instructions);
      runtime.reset();
      disasmEncodings = buildDisasmEncodings(disasmLines);

      sessionId = LOCAL_SIM_SESSION;
      resetMemoryView();
      const initial = buildSnapshot();
      setHistory(initial);
      stackTracker.reset();
      setCallStackExplainer("Step into a function to see the calling convention.");
      renderAll(initial);
      syncCallStackUi(stackTracker.getCallStack());
      setAnimationsEnabled(true);
      resetAnimator();
      stepBtn.disabled = !sessionId;
      runBtn.disabled = !sessionId;
      resetBtn.disabled = !sessionId;
      statusEl.textContent = successMessage;
      setStatus("assembled");
      succeeded = true;
    } catch (err) {
      const message = (err as Error).message;
      setPanelMessage(effectsEl, `Error: ${message}`, "danger");
      sessionId = undefined;
      disasmLines = [];
      setStackLabelResolver(null, "main");
      setCallStackPlaceholder("main");
      clikeByPc = new Map<number, string>();
      disasmEncodings = new Map<number, string>();
      programDataBytes = new Uint8Array();
      resetMemoryControls(0);
      history = [];
      historyIndex = -1;
      stackTracker.reset();
      runBtn.disabled = true;
      resetBtn.disabled = true;
      stepBackBtn.disabled = true;
      statusEl.textContent = "";
      pcEl.textContent = "";
      disasmEl.innerHTML = renderDisasm(undefined, undefined, []);
      clikeEl.innerHTML = renderClikeExpression(null);
      setCallStackExplainer("Step into a function to see the calling convention.");
      syncCallStackUi(stackTracker.getCallStack());
      resetAnimator();
      setStatus("ready");
    } finally {
      stopAssembleSpinner();
      if (showSpinner) {
        stopAssembleProgress();
      }
    }

    return succeeded;
  }

  function applyEditorSource(
    source: string,
    options: {
      sampleName?: string;
      programId?: string | null;
      name?: string | null;
      statusMessage?: string;
      focus?: boolean;
      keepSharedBanner?: boolean;
    } = {}
  ) {
    syncSampleOptionLabels(options.sampleName ?? "__custom__");
    setStackLabelResolver(null, "main");
    setCallStackPlaceholder("main");
    setCallStackExplainer("Step into a function to see the calling convention.");
    sourceEl.value = source;
    sourceEl.scrollTop = 0;
    sourceEl.scrollLeft = 0;
    programDataBytes = new Uint8Array();
    resetMemoryControls(0);
    resetEffectFilters();
    setSharedBannerVisible(options.keepSharedBanner === true);
    renderHighlightedSource();
    updateLineNumbers();
    clearPanels();
    sessionId = undefined;
    disasmLines = [];
    clikeByPc = new Map<number, string>();
    disasmEncodings = new Map<number, string>();
    history = [];
    historyIndex = -1;
    stopRun();
    stopAssembleSpinner();
    setAnimationsEnabled(true);
    resetAnimator();
    statusEl.textContent = runtime ? options.statusMessage ?? "" : "Initializing Rust/WASM simulator…";
    assembleBtn.disabled = runtime === null;
    resetBtn.disabled = true;
    stepBtn.disabled = true;
    stepBtn.textContent = "Step";
    runBtn.disabled = true;
    stepBackBtn.disabled = true;
    setCurrentProgramState({
      programId: options.programId ?? null,
      name: options.name ?? null,
      isDirty: false,
    });
    if (options.focus !== false) {
      sourceEl.focus();
    }
    setStatus("ready");
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
      "# Watch the CALL STACK panel on the right.",
      "# Step through to see:",
      "# 1. Stack frame allocated with addi sp, sp, -16",
      "# 2. ra and s0 saved to memory with sw",
      "# 3. New frame pushed when jal calls double",
      "# 4. Frame popped when jalr returns",
      "# 5. Saved registers restored",
      "",
      "# Calling convention demo",
      "# calls double(x) which returns x * 2",
      "main:",
      "addi sp, sp, -16     # allocate frame",
      "sw   ra, 12(sp)      # save return address",
      "sw   s0, 8(sp)       # save s0",
      "addi a0, x0, 21      # argument: 21",
      "jal  ra, double      # call double",
      "mv   s0, a0          # save result",
      "lw   ra, 12(sp)      # restore ra",
      "lw   s0, 8(sp)       # restore s0",
      "addi sp, sp, 16      # deallocate frame",
      "beq  x0, x0, done    # end",
      "double:",
      "addi sp, sp, -8      # callee frame",
      "sw   ra, 4(sp)       # save ra",
      "add  a0, a0, a0      # a0 = a0 * 2",
      "lw   ra, 4(sp)       # restore ra",
      "addi sp, sp, 8       # deallocate",
      "jalr x0, ra, 0       # return",
      "done:",
      "beq  x0, x0, done    # halt",
    ].join("\n"),
    recursiveFactorial: [
      "# Recursive factorial",
      "# factorial(5) = 120",
      "# Watch the call stack grow and shrink",
      "main:",
      "addi a0, x0, 5       # n = 5",
      "jal  ra, factorial",
      "beq  x0, x0, done",
      "factorial:",
      "addi sp, sp, -8",
      "sw   ra, 4(sp)",
      "sw   a0, 0(sp)",
      "slti t0, a0, 2       # if n < 2",
      "bne  t0, x0, base    # go to base case",
      "addi a0, a0, -1      # n - 1",
      "jal  ra, factorial   # recursive call",
      "lw   t0, 0(sp)       # reload n",
      "mul  a0, t0, a0      # n * factorial(n-1)",
      "lw   ra, 4(sp)",
      "addi sp, sp, 8",
      "jalr x0, ra, 0",
      "base:",
      "addi a0, x0, 1       # base case: return 1",
      "lw   ra, 4(sp)",
      "addi sp, sp, 8",
      "jalr x0, ra, 0",
      "done:",
      "beq  x0, x0, done",
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
    bubbleSortData: [
      "# Sample: bubble sort over a .data array",
      "# Watch the data segment in the memory panel as adjacent words swap into order.",
      ".data",
      "arr:",
      "  .word 5, 2, 8, 1, 4",
      ".text",
      "la   x1, arr",
      "addi x2, x0, 4        # outer passes",
      "outer:",
      "beq  x2, x0, done",
      "addi x3, x0, 0        # i",
      "inner:",
      "beq  x3, x2, next_pass",
      "slli x4, x3, 2",
      "add  x5, x1, x4",
      "lw   x6, 0(x5)",
      "lw   x7, 4(x5)",
      "bge  x7, x6, no_swap",
      "sw   x7, 0(x5)",
      "sw   x6, 4(x5)",
      "no_swap:",
      "addi x3, x3, 1",
      "beq  x0, x0, inner",
      "next_pass:",
      "addi x2, x2, -1",
      "beq  x0, x0, outer",
      "done:",
      "ecall",
    ].join("\n"),
    stringCopyData: [
      "# Sample: copy a null-terminated .data string into a destination buffer",
      "# Watch bytes appear in the destination buffer in the memory panel.",
      ".data",
      "src:",
      '  .asciz "Hello, RISC-V!"',
      "dst:",
      "  .space 32",
      ".text",
      "la   x1, src",
      "la   x2, dst",
      "copy_loop:",
      "lb   x3, 0(x1)",
      "sb   x3, 0(x2)",
      "beq  x3, x0, done",
      "addi x1, x1, 1",
      "addi x2, x2, 1",
      "beq  x0, x0, copy_loop",
      "done:",
      "ecall",
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

  function loadSample(name: string) {
    applyEditorSource(samplePrograms[name] ?? "", {
      sampleName: name,
      statusMessage: "",
    });
  }

  if (
    !saveProgramBtn ||
    !saveProgramDirtyIndicator ||
    !savedProgramsPanel ||
    !savedProgramsBody ||
    !savedProgramsToggle ||
    !historyPanel ||
    !historyBody ||
    !historyToggle
  ) {
    throw new Error("Saved programs UI is missing required elements.");
  }

  programsUi = createProgramsUi({
    saveButton: saveProgramBtn,
    dirtyIndicator: saveProgramDirtyIndicator,
    savedPanel: savedProgramsPanel,
    savedBody: savedProgramsBody,
    savedToggle: savedProgramsToggle,
    historyPanel,
    historyBody,
    historyToggle,
    getSource() {
      return sourceEl.value;
    },
    onLoadProgram(payload) {
      applyEditorSource(payload.source, {
        programId: payload.programId,
        name: payload.name,
        statusMessage: payload.programId ? "Saved program loaded." : "History entry loaded.",
      });
    },
    onProgramPersisted(program) {
      setCurrentProgramState({
        programId: program.programId,
        name: program.name,
        isDirty: false,
      });
    },
    onProgramDeleted(programId) {
      if (currentProgram.programId === programId) {
        resetCurrentProgramState();
      }
    },
    onToast(message) {
      showToast(message);
    },
    onMessage(message) {
      statusEl.textContent = message;
      showToast(message);
    },
  });
  syncCurrentProgramUi();

  themeToggle?.addEventListener("click", () => {
    const isDark = document.documentElement.dataset.theme === "dark";
    if (isDark) {
      document.documentElement.removeAttribute("data-theme");
      window.localStorage.setItem(THEME_KEY, "light");
    } else {
      document.documentElement.dataset.theme = "dark";
      window.localStorage.setItem(THEME_KEY, "dark");
    }
    applyThemeIcon();
  });
  applyThemeIcon();
  setStatus("ready");
  currentUserSession = await initAuthUi({
    onSession(session) {
      currentUserSession = session;
      void programsUi?.setSession(session);
    },
  });
  await programsUi?.setSession(currentUserSession);

  sourceEl.addEventListener("input", handleSourceInput);
  sourceEl.addEventListener("keyup", updateLineNumbers);
  sourceEl.addEventListener("click", updateLineNumbers);
  sourceEl.addEventListener("scroll", () => {
    updateLineNumbers();
    syncHighlightScroll();
  });
  sourceEl.addEventListener("focus", updateLineNumbers);
  sourceEl.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") {
      return;
    }
    event.preventDefault();
    insertTextAtSelection("  ");
  });

  sampleSelect.onchange = () => {
    loadSample(sampleSelect.value || "arraySum");
  };

  effectFilterRegBtn?.addEventListener("click", () => {
    effectFilters = { ...effectFilters, reg: !effectFilters.reg };
    updateEffectFilterButtons();
    effectsEl.innerHTML = renderEffectLog();
  });

  effectFilterMemBtn?.addEventListener("click", () => {
    effectFilters = { ...effectFilters, mem: !effectFilters.mem };
    updateEffectFilterButtons();
    effectsEl.innerHTML = renderEffectLog();
  });

  effectFilterPcBtn?.addEventListener("click", () => {
    effectFilters = { ...effectFilters, pc: !effectFilters.pc };
    updateEffectFilterButtons();
    effectsEl.innerHTML = renderEffectLog();
  });

  memAddressInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitMemoryAddressInput();
      sourceEl.focus();
    }
  });

  memAddressInput?.addEventListener("blur", () => {
    commitMemoryAddressInput();
  });

  memFollowSelect?.addEventListener("change", () => {
    memoryFollowMode = (memFollowSelect.value as MemoryFollowMode) || "none";
    updateMemoryWindow(currentSnapshot()?.regs);
  });

  dismissSharedBannerBtn?.addEventListener("click", () => {
    if (sharedLinkBannerEl) {
      sharedLinkBannerEl.style.display = "none";
      sharedLinkBannerEl.hidden = true;
    }
    clearSharedLinkHash();
  });

  copySourceBtn?.addEventListener("click", () => {
    void copySourceToClipboard();
  });

  shareSourceBtn?.addEventListener("click", async () => {
    await pushToUrl(sourceEl.value);
    await copyTextToClipboard(window.location.href, "Link copied!");
  });

  const sharedProgram = await readFromUrl();
  if (sharedProgram) {
    setSharedBannerVisible(true);
    applyEditorSource(sharedProgram, {
      keepSharedBanner: true,
      statusMessage: "",
      focus: false,
    });
  } else {
    setSharedBannerVisible(false);
    loadSample(sampleSelect.value || "arraySum");
  }

  resetEffectFilters();
  resetMemoryControls(0);

  statusEl.textContent = "Initializing Rust/WASM simulator…";
  assembleBtn.disabled = true;
  WasmRuntime.create()
    .then(async (rt) => {
      runtime = rt;
      rt.setAlignmentChecks(true);
      statusEl.textContent = "Rust/WASM simulator ready.";
      assembleBtn.disabled = false;
      if (sharedProgram) {
        await assembleCurrentSource(true, "Loaded from shared link.");
      }
    })
    .catch((err) => {
      statusEl.textContent = `Failed to initialize WASM: ${(err as Error).message}`;
      assembleBtn.disabled = true;
      setStatus("ready");
    });

  assembleBtn.onclick = async () => {
    const assembled = await assembleCurrentSource(true, "Program assembled. Ready to step.");
    if (assembled && currentUserSession?.isGtStudent) {
      programsUi?.recordHistory(sourceEl.value);
    }
  };

  resetBtn.onclick = async () => {
    resetCurrentProgramState();
    await assembleCurrentSource(false, "Program reset.");
    updateLineNumbers();
    syncHighlightScroll();
  };

  stepBackBtn.onclick = () => {
    if (!sessionId || historyIndex <= 0) {
      return;
    }
    stopRun();
    historyIndex -= 1;
    stackTracker.stepBack();
    renderFromHistory(historyIndex, false);
    resetAnimator();
    statusEl.textContent = "Viewing previous state.";
  };

  stepBtn.onclick = async () => {
    if (!runtime) {
      setPanelMessage(effectsEl, "WASM module not initialized yet.", "danger");
      return;
    }
    if (!sessionId) {
      setPanelMessage(effectsEl, "No local session. Click Assemble first.", "danger");
      return;
    }

    if (historyIndex < history.length - 1) {
      historyIndex += 1;
      stackTracker.applyDelta(snapshotToDelta(history[historyIndex]));
      renderFromHistory(historyIndex, false);
      statusEl.textContent = "Viewing recorded state.";
      setStatus("assembled");
      return;
    }

    try {
      setStatus("stepping");
      const beforeCallStack = stackTracker.getCallStack();
      const delta = runtime.step();
      const data = buildSnapshot(delta);
      pushHistory(data);
      stackTracker.applyDelta(delta);
      const afterCallStack = stackTracker.getCallStack();
      const pushedFrame =
        afterCallStack.frames.length > beforeCallStack.frames.length
          ? afterCallStack.frames[afterCallStack.frames.length - 1]
          : undefined;
      const poppedFrame =
        afterCallStack.frames.length < beforeCallStack.frames.length
          ? beforeCallStack.frames[beforeCallStack.frames.length - 1]
          : undefined;
      const currentFrameWrites =
        delta.effects.some((effect) => effect.kind === "mem")
          ? collectCurrentFrameWrites(beforeCallStack, afterCallStack)
          : [];
      renderAll(data);
      setCallStackExplainer(buildCallStackExplainer(beforeCallStack, afterCallStack));
      renderCallStack(afterCallStack);
      animateStep(delta);
      if (pushedFrame || poppedFrame || currentFrameWrites.length > 0) {
        window.requestAnimationFrame(() => {
          if (pushedFrame) {
            animateFramePush(pushedFrame);
          }
          if (poppedFrame) {
            animateFramePop(poppedFrame);
          }
          for (const write of currentFrameWrites) {
            animateSlotWrite(write.address, write.value);
          }
        });
      }
      if (!data.halted && !data.trap) {
        statusEl.textContent = "Step completed.";
        setStatus("stepping");
      }
    } catch (err) {
      setPanelMessage(effectsEl, `Error: ${(err as Error).message}`, "danger");
      setStatus("ready");
    }
  };

  runBtn.onclick = async () => {
    if (!runtime) {
      setPanelMessage(effectsEl, "WASM module not initialized yet.", "danger");
      return;
    }
    const activeRuntime = runtime;
    if (!sessionId) {
      setPanelMessage(effectsEl, "No local session. Click Assemble first.", "danger");
      return;
    }
    if (historyIndex < history.length - 1) {
      setPanelMessage(effectsEl, "Step forward to the latest state before running.", "danger");
      return;
    }

    assembleBtn.disabled = true;
    stepBtn.disabled = true;
    runBtn.disabled = true;
    runBtn.textContent = "Running…";
    statusEl.textContent = "Running locally (WASM)…";
    setStatus("running");
    setAnimationsEnabled(false);

    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });

    let lastDelta: WasmStateDelta | null = null;
    let finalMessage = `Run stopped after ${MAX_RUN_STEPS} steps.`;

    try {
      for (let stepIndex = 0; stepIndex < MAX_RUN_STEPS; stepIndex++) {
        const delta = activeRuntime.step();
        lastDelta = delta;
        const data = buildSnapshot(delta);
        pushHistory(data);

        if (data.trap) {
          finalMessage = fmtTrap(data.trap);
          break;
        }
        if (data.halted) {
          finalMessage = "Program halted.";
          break;
        }
        if (isPcStalled(data.effects ?? [])) {
          finalMessage = "Halt loop detected.";
          break;
        }
      }

      stopRun();
      if (historyIndex >= 0) {
        renderFromHistory(historyIndex);
      }
      statusEl.textContent = finalMessage;
      setAnimationsEnabled(true);
      if (lastDelta) {
        animateStep(lastDelta);
        if (!lastDelta.halted && !lastDelta.trap && !isPcStalled(lastDelta.effects ?? [])) {
          setStatus("assembled");
        }
      } else {
        resetAnimator();
        setStatus("assembled");
      }
    } catch (err) {
      setAnimationsEnabled(true);
      stopRun(`Error: ${(err as Error).message}`);
      assembleBtn.disabled = false;
      stepBtn.disabled = !sessionId;
      runBtn.disabled = !sessionId;
      setStatus("ready");
      return;
    }

    assembleBtn.disabled = false;
  };

  function isEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) {
      return false;
    }
    if (target === sourceEl) {
      return true;
    }
    return Boolean(target.closest("textarea, input, select, button, [contenteditable='true']"));
  }

  function confirmResetIfNeeded(): boolean {
    if (!sessionId) {
      return false;
    }
    return window.confirm("Reset the assembled program and clear the current execution state?");
  }

  // UI keyboard shortcuts
  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented) {
      return;
    }

    const targetIsEditable = isEditableTarget(event.target);

    if (event.key === "Enter" && !targetIsEditable) {
      event.preventDefault();
      if (!assembleBtn.disabled) {
        void assembleBtn.click();
      }
      return;
    }

    if (event.key === "ArrowDown" && !targetIsEditable) {
      event.preventDefault();
      if (event.shiftKey) {
        if (!stepBackBtn.disabled) {
          stepBackBtn.click();
        }
      } else if (!stepBtn.disabled) {
        void stepBtn.click();
      }
      return;
    }

    if (event.code === "KeyR" && !targetIsEditable) {
      event.preventDefault();
      if (!runBtn.disabled) {
        void runBtn.click();
      }
      return;
    }

    if (event.key === "Escape" && !targetIsEditable) {
      event.preventDefault();
      if (!resetBtn.disabled && confirmResetIfNeeded()) {
        void resetBtn.click();
      }
    }
  });
});
