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
import { initFooter } from "./footer";
import {
  escapeHtml,
  formatClikeExpression,
  fmtTrap,
  hex8,
  hex32,
  renderClikeExpression,
} from "./format";
import { BreakpointManager, parseBreakpointCondition } from "./breakpoints";
import { createChallengeMode } from "./challenge-ui";
import { getClipLine, recordStep as recordClipStep, shouldSpeak, type ClipContext, type ClipEvent } from "./clip-dialogue";
import { initClipBubble, showClipLine } from "./clip-ui";
import { createEditor } from "./editor";
import { createLabMode } from "./lab-mode";
import { createLessonMode } from "./lesson-mode";
import { lintProgram, type LintWarning } from "./linter";
import { DATA_BASE } from "./memory-map";
import { createMemoryView, type MemoryViewMode, type MemoryWordFormat } from "./memory";
import { initNav } from "./nav";
import { showNotification } from "./notifications";
import { pushToUrl, readFromUrl } from "./permalink";
import { createProgramsUi, type ProgramsUiController } from "./programs-ui";
import { createRegistersUi } from "./registers-ui";
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
type CenterTabId = "disassembly" | "call-stack" | "effects" | "pseudo-c";
type RunSpeedPreset = 1 | 10 | 50 | 100 | 250 | 500 | -1;

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

const RUN_SPEED_PRESETS: RunSpeedPreset[] = [1, 10, 50, 100, 250, 500, -1];
const RUN_SPEED_STORAGE_KEY = "studyriscv_run_speed";

window.addEventListener("DOMContentLoaded", async () => {
  const detectMobile = (): boolean =>
    window.innerWidth < 768 || ("ontouchstart" in window && window.innerWidth < 1024);

  const syncMobileBodyClass = (): void => {
    document.body.classList.toggle("is-mobile", detectMobile());
  };

  syncMobileBodyClass();

  if (detectMobile()) {
    window.addEventListener("orientationchange", () => {
      window.setTimeout(() => {
        syncMobileBodyClass();
      }, 100);
    });
    import("./mobile-sim").then((module) => {
      void module.initMobileSim();
    });
    return;
  }

  initNav({ activePage: "simulator" });
  initFooter();
  initClipBubble();

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
  const editorContainerEl = sourceEl.closest(".editor-container") as HTMLElement | null;
  const sourceLinesEl = document.getElementById("line-numbers") as HTMLElement | null;
  const highlightDisplayEl = document.getElementById("highlight-display") as HTMLElement | null;
  const runSpeedPanelEl = document.getElementById("runSpeedPanel") as HTMLElement | null;
  const runSpeedEl = document.getElementById("runSpeed") as HTMLInputElement | null;
  const runSpeedValueEl = document.getElementById("runSpeedValue") as HTMLElement | null;
  const runStatsEl = document.getElementById("runStats") as HTMLElement | null;
  const shortcutHintBarEl = document.getElementById("shortcutHintBar") as HTMLElement | null;
  const shortcutHintDismissBtn = document.getElementById("shortcutHintDismiss") as HTMLButtonElement | null;
  const breakpointsPanelEl = document.getElementById("breakpointsPanel") as HTMLElement | null;
  const breakpointsCountEl = document.getElementById("breakpointsCount") as HTMLElement | null;
  const breakpointsListEl = document.getElementById("breakpointsList") as HTMLElement | null;
  const breakpointsClearAllBtn = document.getElementById("breakpointsClearAll") as HTMLButtonElement | null;
  const warningsPanelEl = document.getElementById("warningsPanel") as HTMLElement | null;
  const warningsToggleBtn = document.getElementById("warningsToggle") as HTMLButtonElement | null;
  const warningsHeadingEl = document.getElementById("warningsHeading") as HTMLElement | null;
  const warningsBodyEl = document.getElementById("warningsBody") as HTMLElement | null;

  const clikeEl = document.getElementById("clike") as HTMLElement;
  const effectsEl = document.getElementById("effects") as HTMLElement;
  const effectFilterRegBtn = document.getElementById("effectFilterReg") as HTMLButtonElement | null;
  const effectFilterMemBtn = document.getElementById("effectFilterMem") as HTMLButtonElement | null;
  const effectFilterPcBtn = document.getElementById("effectFilterPc") as HTMLButtonElement | null;
  const regsEl = document.getElementById("regs") as HTMLElement;
  const pcEl = document.getElementById("pc") as HTMLElement;
  const disasmEl = document.getElementById("disasm") as HTMLElement;
  const goToPcBtn = document.getElementById("goToPc") as HTMLButtonElement | null;
  const disasmProgressTextEl = document.getElementById("disasmProgressText") as HTMLElement | null;
  const disasmProgressFillEl = document.getElementById("disasmProgressFill") as HTMLElement | null;
  const disasmCompleteBadgeEl = document.getElementById("disasmCompleteBadge") as HTMLElement | null;
  const memWritesEl = document.getElementById("memWrites") as HTMLElement;
  const memWindowEl = document.getElementById("memWindow") as HTMLElement;
  const memWatchesEl = document.getElementById("memWatches") as HTMLElement | null;
  const memWatchInput = document.getElementById("memWatchInput") as HTMLInputElement | null;
  const memWatchAddBtn = document.getElementById("memWatchAdd") as HTMLButtonElement | null;
  const memoryModeButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-memory-mode]"));
  const memoryWordFormatButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-memory-word-format]"));
  const memoryWordFormatsEl = document.getElementById("memoryWordFormats") as HTMLElement | null;
  const memAddressInput = document.getElementById("memAddressInput") as HTMLInputElement | null;
  const memFollowSelect = document.getElementById("memFollowSelect") as HTMLSelectElement | null;
  const statusPrimaryEl = document.getElementById("statusPrimary") as HTMLElement | null;
  const statusSecondaryEl = document.getElementById("statusSecondary") as HTMLElement | null;
  const statusBadgeEl = document.getElementById("nav-status-badge") as HTMLElement | null;
  const sampleSelect = document.getElementById("sampleSelect") as HTMLSelectElement;
  const savedProgramsPanel = document.getElementById("savedProgramsPanel") as HTMLElement | null;
  const savedProgramsBody = document.getElementById("savedProgramsBody") as HTMLElement | null;
  const savedProgramsToggle = document.getElementById("savedProgramsToggle") as HTMLButtonElement | null;
  const historyPanel = document.getElementById("historyPanel") as HTMLElement | null;
  const historyBody = document.getElementById("historyBody") as HTMLElement | null;
  const historyToggle = document.getElementById("historyToggle") as HTMLButtonElement | null;
  const centerTabButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-center-tab]"));
  const centerTabPanels = Array.from(document.querySelectorAll<HTMLElement>("[data-center-panel]"));

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
  let callStackTabFlashTimer: number | null = null;
  let assembleProgressStartedAt = 0;
  let assembleProgressResetTimer: number | null = null;
  let programDataBytes = new Uint8Array();
  let manualMemoryBase = 0;
  let memoryFollowMode: MemoryFollowMode = "none";
  let effectFilters: EffectLogFilters = { ...DEFAULT_EFFECT_FILTERS };
  let memoryInputInvalidTimer: number | null = null;
  let activeCenterTab: CenterTabId = "disassembly";
  const sampleOptionLabels = new Map<string, string>(
    Array.from(sampleSelect.options).map((option) => [option.value, option.textContent ?? option.value])
  );
  const breakpointManager = new BreakpointManager();
  const registersUi = createRegistersUi(regsEl);
  const editor = createEditor({
    container: editorContainerEl as HTMLElement,
    textarea: sourceEl,
    lineNumbers: sourceLinesEl as HTMLElement,
    highlightDisplay: highlightDisplayEl as HTMLElement,
    onGutterClick(line) {
      breakpointManager.toggle(line);
      renderBreakpointPanel();
      editor.setBreakpoints(breakpointManager.getAll());
    },
  });
  let currentWarnings: LintWarning[] = [];
  let warningsExpanded = true;
  let currentParsedProgram: ReturnType<typeof parseAssembly> | null = null;
  let memoryMode: MemoryViewMode = "bytes";
  let memoryWordFormat: MemoryWordFormat = "hex";
  let memoryWatches: number[] = [];
  let runSpeed: RunSpeedPreset = loadStoredRunSpeed();
  let runRequested = false;
  let isRunning = false;
  let latestRenderAt = 0;
  let runStats = {
    startedAt: 0,
    elapsedMs: 0,
    instructions: 0,
    cycles: 0,
  };
  let breakpointConditionPopoverEl: HTMLDivElement | null = null;
  let breakpointConditionInputEl: HTMLInputElement | null = null;
  let breakpointConditionErrorEl: HTMLElement | null = null;
  let editingBreakpointId: string | null = null;

  function loadStoredRunSpeed(): RunSpeedPreset {
    try {
      const stored = window.localStorage.getItem(RUN_SPEED_STORAGE_KEY);
      if (stored === "1" || stored === "10" || stored === "50" || stored === "100" || stored === "250" || stored === "500" || stored === "-1") {
        return Number(stored) as RunSpeedPreset;
      }
    } catch {
      // Ignore storage access failures and fall back to the default.
    }
    return 100;
  }

  function removeShortcutHintsBar(): void {
    const hintsBar =
      shortcutHintBarEl ??
      document.querySelector<HTMLElement>(".hints-bar") ??
      document.querySelector<HTMLElement>("[class*='hint-bar']") ??
      document.querySelector<HTMLElement>("[class*='shortcuts-bar']") ??
      document.querySelector<HTMLElement>("[class*='keyboard-hint']");
    hintsBar?.remove();
  }

  function setActiveCenterTab(tabId: CenterTabId) {
    activeCenterTab = tabId;

    for (const button of centerTabButtons) {
      const isActive = button.dataset.centerTab === tabId;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-selected", String(isActive));
      button.tabIndex = isActive ? 0 : -1;
    }

    for (const panel of centerTabPanels) {
      const isActive = panel.dataset.centerPanel === tabId;
      panel.classList.toggle("is-active", isActive);
      panel.hidden = !isActive;
    }
  }

  function maybeSwitchToDisassembly(effects: Effect[]): void {
    const pcEffect = effects.find((effect): effect is Extract<Effect, { kind: "pc" }> => effect.kind === "pc");
    if (!pcEffect || pcEffect.before === pcEffect.after) {
      return;
    }

    if (activeCenterTab === "effects" || activeCenterTab === "pseudo-c") {
      setActiveCenterTab("disassembly");
    }
  }

  function flashCenterTab(tabId: CenterTabId): void {
    const button = centerTabButtons.find((candidate) => candidate.dataset.centerTab === tabId);
    if (!button) {
      return;
    }

    button.classList.remove("is-flashing");
    void button.offsetWidth;
    button.classList.add("is-flashing");
    if (callStackTabFlashTimer !== null) {
      window.clearTimeout(callStackTabFlashTimer);
    }
    callStackTabFlashTimer = window.setTimeout(() => {
      button.classList.remove("is-flashing");
      callStackTabFlashTimer = null;
    }, 600);
  }

  function syncHighlightScroll() {
    editor.sync();
  }
  function renderHighlightedSource() {
    editor.sync();
  }

  function updateLineNumbers() {
    editor.sync();
  }

  function handleSourceInput() {
    editor.sync();
    if (!currentProgram.isDirty) {
      updateCurrentProgramState({ isDirty: true });
    }
  }

  function syncSampleOptionLabels() {
    for (const option of Array.from(sampleSelect.options)) {
      const baseLabel = sampleOptionLabels.get(option.value) ?? option.value;
      option.textContent = baseLabel;
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

  function setStatusDetails(primary: string, secondary = ""): void {
    if (statusPrimaryEl) {
      statusPrimaryEl.textContent = primary;
    }
    if (statusSecondaryEl) {
      statusSecondaryEl.textContent = secondary;
    }
  }

  function maybeShowClip(event: ClipEvent, context: ClipContext): void {
    const line = getClipLine(event, context);
    if (line && shouldSpeak(line.priority)) {
      showClipLine(line);
    }
  }

  function updateWarningsPanel(warnings: LintWarning[]): void {
    currentWarnings = warnings;
    if (!warningsPanelEl || !warningsBodyEl || !warningsHeadingEl || !warningsToggleBtn) {
      return;
    }
    warningsPanelEl.hidden = warnings.length === 0;
    warningsToggleBtn.setAttribute("aria-expanded", String(warningsExpanded));
    warningsHeadingEl.textContent = `Warnings (${warnings.length})`;
    warningsBodyEl.hidden = !warningsExpanded;
    warningsBodyEl.innerHTML = warnings
      .map(
        (warning) => `
          <div class="warnings-panel__item">
            <span class="warnings-panel__code">${escapeHtml(warning.code)}</span>
            <span class="warnings-panel__line">Line ${warning.line}</span>
            <span class="warnings-panel__message">${escapeHtml(warning.message)}</span>
          </div>
        `
      )
      .join("");
  }

  function renderBreakpointPanel(): void {
    if (!breakpointsPanelEl || !breakpointsCountEl || !breakpointsListEl) {
      return;
    }
    const breakpoints = breakpointManager.getAll();
    if (editingBreakpointId && !breakpoints.some((breakpoint) => breakpoint.id === editingBreakpointId)) {
      closeBreakpointConditionEditor();
    }
    breakpointsPanelEl.hidden = breakpoints.length === 0;
    breakpointsCountEl.textContent = `BREAKPOINTS (${breakpoints.length})`;
    breakpointsListEl.innerHTML = breakpoints
      .map(
        (breakpoint) => `
          <div class="breakpoint-row">
            <span class="breakpoint-row__dot"></span>
            <span class="breakpoint-row__text">Line ${breakpoint.line}${breakpoint.address !== undefined ? ` · ${hex32(breakpoint.address)}` : ""} · hit ${breakpoint.hitCount}x</span>
            ${breakpoint.condition ? `<span class="breakpoint-row__condition-badge">cond</span><span class="breakpoint-row__condition">${escapeHtml(breakpoint.condition)}</span>` : ""}
            <button type="button" class="breakpoint-row__remove" data-breakpoint-id="${escapeHtml(breakpoint.id)}" aria-label="Remove breakpoint">🗑</button>
          </div>
        `
      )
      .join("");
  }

  function ensureBreakpointConditionPopover(): void {
    if (breakpointConditionPopoverEl || !editorContainerEl) {
      return;
    }
    const popover = document.createElement("div");
    popover.className = "breakpoint-condition-popover";
    popover.hidden = true;
    popover.innerHTML = `
      <div class="breakpoint-condition-popover__title">Conditional breakpoint</div>
      <input
        type="text"
        class="breakpoint-condition-popover__input"
        placeholder="x1 == 10"
        aria-label="Breakpoint condition"
      />
      <div class="breakpoint-condition-popover__hint">Use x0-x31 or ABI names with ==, !=, &lt;, &gt;, &lt;=, &gt;=.</div>
      <div class="breakpoint-condition-popover__error" hidden></div>
      <div class="breakpoint-condition-popover__actions">
        <button type="button" class="breakpoint-condition-popover__button" data-breakpoint-condition-action="clear">Clear</button>
        <button type="button" class="breakpoint-condition-popover__button breakpoint-condition-popover__button--primary" data-breakpoint-condition-action="save">Save</button>
      </div>
    `;
    editorContainerEl.appendChild(popover);
    breakpointConditionPopoverEl = popover;
    breakpointConditionInputEl = popover.querySelector(".breakpoint-condition-popover__input");
    breakpointConditionErrorEl = popover.querySelector(".breakpoint-condition-popover__error");

    popover.addEventListener("click", (event) => {
      event.stopPropagation();
    });
    breakpointConditionInputEl?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commitBreakpointCondition();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeBreakpointConditionEditor();
      }
    });
    popover.addEventListener("click", (event) => {
      const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-breakpoint-condition-action]");
      if (!target) {
        return;
      }
      const action = target.dataset.breakpointConditionAction;
      if (action === "clear") {
        if (breakpointConditionInputEl) {
          breakpointConditionInputEl.value = "";
        }
        commitBreakpointCondition();
        return;
      }
      if (action === "save") {
        commitBreakpointCondition();
      }
    });
  }

  function closeBreakpointConditionEditor(): void {
    editingBreakpointId = null;
    if (breakpointConditionPopoverEl) {
      breakpointConditionPopoverEl.hidden = true;
    }
    if (breakpointConditionInputEl) {
      breakpointConditionInputEl.value = "";
    }
    if (breakpointConditionErrorEl) {
      breakpointConditionErrorEl.textContent = "";
      breakpointConditionErrorEl.hidden = true;
    }
  }

  function commitBreakpointCondition(): void {
    if (!editingBreakpointId || !breakpointConditionInputEl) {
      return;
    }
    const value = breakpointConditionInputEl.value.trim();
    if (value && !parseBreakpointCondition(value)) {
      if (breakpointConditionErrorEl) {
        breakpointConditionErrorEl.hidden = false;
        breakpointConditionErrorEl.textContent = "Use forms like x1 == 10, sp == 0x7FFFFFF4, or a0 > 3.";
      }
      return;
    }
    breakpointManager.setCondition(editingBreakpointId, value || undefined);
    editor.setBreakpoints(breakpointManager.getAll());
    renderBreakpointPanel();
    closeBreakpointConditionEditor();
  }

  function openBreakpointConditionEditor(line: number, targetRect: DOMRect): void {
    const breakpoint = breakpointManager.getByLine(line);
    if (!breakpoint || !editorContainerEl) {
      return;
    }
    ensureBreakpointConditionPopover();
    if (!breakpointConditionPopoverEl || !breakpointConditionInputEl) {
      return;
    }
    const containerRect = editorContainerEl.getBoundingClientRect();
    editingBreakpointId = breakpoint.id;
    breakpointConditionInputEl.value = breakpoint.condition ?? "";
    if (breakpointConditionErrorEl) {
      breakpointConditionErrorEl.textContent = "";
      breakpointConditionErrorEl.hidden = true;
    }
    breakpointConditionPopoverEl.style.top = `${Math.max(8, targetRect.bottom - containerRect.top + 6)}px`;
    breakpointConditionPopoverEl.style.left = `${Math.max(8, targetRect.right - containerRect.left + 8)}px`;
    breakpointConditionPopoverEl.hidden = false;
    breakpointConditionInputEl.focus();
    breakpointConditionInputEl.select();
  }

  function updateRunSpeedUi(): void {
    if (runSpeedEl) {
      runSpeedEl.value = String(Math.max(0, RUN_SPEED_PRESETS.indexOf(runSpeed)));
    }
    if (runSpeedValueEl) {
      runSpeedValueEl.textContent = runSpeed === -1 ? "MAX" : `${runSpeed} inst/s`;
    }
  }

  function persistRunSpeed(): void {
    try {
      window.localStorage.setItem(RUN_SPEED_STORAGE_KEY, String(runSpeed));
    } catch {
      // Ignore storage failures.
    }
  }

  function updateRunStatsUi(): void {
    if (!runStatsEl) {
      return;
    }
    const ips = runStats.elapsedMs > 0 ? Math.round((runStats.instructions / runStats.elapsedMs) * 1000) : 0;
    runStatsEl.hidden = runStats.instructions === 0 && !isRunning;
    runStatsEl.textContent = `Executed ${runStats.instructions} instructions · ${runStats.cycles} cycles · ${Math.round(
      runStats.elapsedMs
    )}ms · ${ips} inst/s`;
  }

  function updateDisasmProgress(snapshot?: ApiResponse): void {
    const executableLines = (disasmLines ?? []).filter((line) => !line.label);
    const total = executableLines.length;
    const currentPc = snapshot?.pc ?? currentSnapshot()?.pc;
    const currentIndex = total > 0 && currentPc !== undefined ? executableLines.findIndex((line) => line.pc === currentPc) : -1;
    const currentStep = currentIndex >= 0 ? currentIndex + 1 : 0;
    const halted = snapshot?.halted === true || currentSnapshot()?.halted === true;
    const ratio = total > 0 ? (halted ? 1 : Math.max(0, currentStep) / total) : 0;

    if (disasmProgressTextEl) {
      disasmProgressTextEl.textContent = total > 0 ? `Step ${Math.max(0, currentStep)} / ${total}` : "";
    }
    if (disasmProgressFillEl) {
      disasmProgressFillEl.style.width = `${ratio * 100}%`;
      disasmProgressFillEl.classList.toggle("is-complete", halted && total > 0);
    }
    if (disasmCompleteBadgeEl) {
      disasmCompleteBadgeEl.hidden = !(halted && total > 0);
    }
  }

  function updateGoToPcButton(pc: number | undefined): void {
    if (!goToPcBtn) {
      return;
    }
    if (pc === undefined) {
      goToPcBtn.hidden = true;
      return;
    }
    goToPcBtn.textContent = `▶ PC: ${hex32(pc)}`;
    const row = disasmEl.querySelector<HTMLElement>(`[data-pc="${pc >>> 0}"]`);
    if (!row) {
      goToPcBtn.hidden = true;
      return;
    }
    const viewRect = disasmEl.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const visible = rowRect.top >= viewRect.top && rowRect.bottom <= viewRect.bottom;
    goToPcBtn.hidden = visible;
  }

  function showBreakpointTooltip(message: string): void {
    showNotification({
      id: `breakpoint-${Date.now()}`,
      type: "quiz",
      title: "Breakpoint hit",
      message,
      icon: "⛔",
      duration: 3000,
      accentColor: "var(--accent)",
    });
  }

  function diagnosticsFromWarnings(
    warnings: LintWarning[]
  ): Array<{ line: number; col?: number; code: string; message: string; severity: "warning" }> {
    return warnings.map((warning) => ({ ...warning, severity: "warning" as const }));
  }

  function diagnosticFromAssemblyError(
    message: string
  ): Array<{ line: number; col?: number; code: string; message: string; severity: "error" }> {
    const lineMatch = /on line (\d+)/i.exec(message);
    const tokenMatch = /"([^"]+)"/.exec(message);
    const line = lineMatch ? Number(lineMatch[1]) : 1;
    const rawLine = sourceEl.value.split("\n")[line - 1] ?? "";
    const tokenIndex = tokenMatch ? rawLine.indexOf(tokenMatch[1]) : -1;
    return [
      {
        line,
        col: tokenIndex >= 0 ? tokenIndex + 1 : undefined,
        code: "ERROR",
        message,
        severity: "error",
      },
    ];
  }

  function breakpointForPc(pc: number, regs?: number[]): ReturnType<BreakpointManager["getAll"]>[number] | undefined {
    return breakpointManager.getMatchingBreakpoint(pc, regs) ?? undefined;
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

  function parseRegisterIndex(token: string | undefined): number | null {
    if (!token) {
      return null;
    }
    const normalized = token.trim().toLowerCase();
    const aliases: Record<string, number> = {
      zero: 0,
      ra: 1,
      sp: 2,
      gp: 3,
      tp: 4,
      t0: 5,
      t1: 6,
      t2: 7,
      s0: 8,
      fp: 8,
      s1: 9,
      a0: 10,
      a1: 11,
      a2: 12,
      a3: 13,
      a4: 14,
      a5: 15,
      a6: 16,
      a7: 17,
      s2: 18,
      s3: 19,
      s4: 20,
      s5: 21,
      s6: 22,
      s7: 23,
      s8: 24,
      s9: 25,
      s10: 26,
      s11: 27,
      t3: 28,
      t4: 29,
      t5: 30,
      t6: 31,
    };
    if (normalized in aliases) {
      return aliases[normalized];
    }
    if (/^x(?:[0-9]|[12][0-9]|3[01])$/.test(normalized)) {
      return Number.parseInt(normalized.slice(1), 10);
    }
    return null;
  }

  function instructionMnemonic(instText: string): string {
    return instText.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  }

  function destRegisterForInstruction(instText: string): number | null {
    const normalized = instText.trim();
    if (!normalized) {
      return null;
    }
    const op = instructionMnemonic(normalized);
    const writesRd = new Set([
      "add",
      "addi",
      "sub",
      "lui",
      "auipc",
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
      "lw",
      "lh",
      "lb",
      "lhu",
      "lbu",
      "jal",
      "jalr",
      "mul",
      "mulh",
      "mulhu",
      "mulhsu",
      "div",
      "divu",
      "rem",
      "remu",
      "li",
      "mv",
      "la",
      "nop",
      "call",
    ]);
    if (!writesRd.has(op) || op === "ret" || op === "j" || op === "ecall" || op === "ebreak") {
      return null;
    }
    const operands = normalized.replace(/^[^\s]+\s*/, "");
    const firstOperand = operands.split(",")[0]?.trim();
    return parseRegisterIndex(firstOperand);
  }

  function findChangedRegister(currentRegs: number[] | undefined, previousRegs: number[] | undefined): number | undefined {
    if (!currentRegs || !previousRegs) {
      return undefined;
    }
    for (let index = 0; index < Math.min(currentRegs.length, previousRegs.length); index += 1) {
      if ((currentRegs[index] >>> 0) !== (previousRegs[index] >>> 0)) {
        return index;
      }
    }
    return undefined;
  }

  function countExecutableInstructions(lines: ApiResponse["disasm"]): number {
    return (lines ?? []).filter((line) => !line.label).length;
  }

  function detectRecursivePattern(source: string): boolean {
    const labels = Array.from(source.matchAll(/^\s*([A-Za-z_.$][\w.$]*):/gm)).map((match) => match[1]);
    if (labels.length === 0) {
      return false;
    }
    const callTargets = Array.from(source.matchAll(/\bjal\b\s+\w+\s*,\s*([A-Za-z_.$][\w.$]*)/g)).map((match) => match[1]);
    return callTargets.some((target) => labels.includes(target) && source.includes(`${target}:`) && source.includes(`jal  ra, ${target}`));
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

  function countLabelsInSource(source: string): number {
    return source
      .split("\n")
      .filter((line) => /^\s*[A-Za-z_.$][\w.$]*:/.test(line))
      .length;
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
    const sp = regs?.[2] ?? base;
    memWindowEl.innerHTML = memoryView.renderWindow(base, {
      mode: memoryMode,
      wordFormat: memoryWordFormat,
      sp,
    });
    if (memWatchesEl) {
      memWatchesEl.innerHTML = memoryView.renderWatches(memoryWordFormat);
      memWatchesEl.hidden = memoryWatches.length === 0;
    }
    if (memoryWordFormatsEl) {
      memoryWordFormatsEl.hidden = !(memoryMode === "words" || memoryMode === "stack");
    }
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
    memoryView.setWatchedAddresses(memoryWatches);
    lastPc = undefined;
    setPanelMessage(memWritesEl, "No memory writes yet.");
    updateMemoryWindow(currentSnapshot()?.regs);
  }

  function clearPanels() {
    clikeEl.innerHTML = renderClikeExpression(null);
    effectsEl.innerHTML = effectEmptyState();
    registersUi.render({});
    pcEl.textContent = "";
    disasmEl.innerHTML = renderDisasm(undefined, undefined, []);
    resetMemoryView();
    stackTracker.reset();
    setCallStackExplainer("Step into a function to see the calling convention.");
    syncCallStackUi(stackTracker.getCallStack());
    resetAnimator();
  }

  function stopRun(message?: string) {
    isRunning = false;
    runRequested = false;
    runBtn.textContent = "Run";
    registersUi.setRunningOverlay(false);
    if (message) {
      setStatusDetails(message, statusSecondaryEl?.textContent ?? "");
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
      return;
    }
    stepBtn.disabled = false;
    runBtn.disabled = false;
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

  function parseRegisterValue(token: string | undefined, regs?: number[]): number | null {
    if (!token || !regs) {
      return null;
    }
    const normalized = token.trim().toLowerCase();
    const aliases: Record<string, number> = {
      zero: 0,
      ra: 1,
      sp: 2,
      gp: 3,
      tp: 4,
      t0: 5,
      t1: 6,
      t2: 7,
      s0: 8,
      fp: 8,
      s1: 9,
      a0: 10,
      a1: 11,
      a2: 12,
      a3: 13,
      a4: 14,
      a5: 15,
      a6: 16,
      a7: 17,
      s2: 18,
      s3: 19,
      s4: 20,
      s5: 21,
      s6: 22,
      s7: 23,
      s8: 24,
      s9: 25,
      s10: 26,
      s11: 27,
      t3: 28,
      t4: 29,
      t5: 30,
      t6: 31,
    };
    const index = aliases[normalized] ?? (/^x(?:[0-9]|[12][0-9]|3[01])$/.test(normalized) ? Number.parseInt(normalized.slice(1), 10) : undefined);
    return index === undefined ? null : regs[index] >>> 0;
  }

  function parseImmediate(token: string | undefined): number | null {
    if (!token) {
      return null;
    }
    const normalized = token.trim();
    const negative = normalized.startsWith("-");
    const body = negative ? normalized.slice(1) : normalized;
    const base = body.startsWith("0x") ? 16 : 10;
    const digits = body.startsWith("0x") ? body.slice(2) : body;
    if (!digits || !/^[0-9a-fA-F]+$/.test(digits)) {
      return null;
    }
    const value = Number.parseInt(digits, base);
    return negative ? -value : value;
  }

  function instructionTextForPc(pc: number | undefined): string {
    if (pc === undefined) {
      return "";
    }
    return (disasmLines ?? []).find((line) => !line.label && line.pc === pc)?.text ?? "";
  }

  function renderPseudoCHtml(snapshot: ApiResponse): string {
    const expression = snapshot.clike && snapshot.clike.trim().length > 0 ? snapshot.clike : snapshot.rv2c ?? "";
    const pc = snapshot.pc;
    const regs = snapshot.regs;
    const instText = instructionTextForPc(pc).trim();
    const [mnemonic, ...operandParts] = instText.replace(/,/g, " ").split(/\s+/).filter(Boolean);
    let body = renderClikeExpression(formatClikeExpression(expression));

    if (mnemonic === "beq" || mnemonic === "bne" || mnemonic === "blt" || mnemonic === "bge" || mnemonic === "bltu" || mnemonic === "bgeu") {
      const [lhs, rhs, target] = operandParts.join(" ").split(/\s+/);
      const leftValue = parseRegisterValue(lhs, regs);
      const rightValue = parseRegisterValue(rhs, regs);
      if (leftValue !== null && rightValue !== null) {
        let taken = false;
        switch (mnemonic) {
          case "beq":
            taken = leftValue === rightValue;
            break;
          case "bne":
            taken = leftValue !== rightValue;
            break;
          case "blt":
            taken = (leftValue | 0) < (rightValue | 0);
            break;
          case "bge":
            taken = (leftValue | 0) >= (rightValue | 0);
            break;
          case "bltu":
            taken = leftValue < rightValue;
            break;
          case "bgeu":
            taken = leftValue >= rightValue;
            break;
        }
        body = `
          <div class="clike-branch">
            <div>if (${escapeHtml(lhs)} ${escapeHtml(mnemonic === "beq" ? "==" : mnemonic === "bne" ? "!=" : mnemonic.includes("lt") ? "<" : ">=")} ${escapeHtml(rhs)})</div>
            <div class="clike-branch__taken${taken ? " is-active" : ""}">pc = ${escapeHtml(target)};</div>
            <div class="clike-branch__else">else</div>
            <div class="clike-branch__fallthrough${taken ? "" : " is-active"}">pc += 4;</div>
          </div>
        `;
      }
    }

    if (["lw", "lh", "lb", "lhu", "lbu", "sw", "sh", "sb"].includes(mnemonic)) {
      const memoryOperand = /([^,]+),\s*([^()]+)\(([^)]+)\)/.exec(instText);
      if (memoryOperand) {
        const imm = parseImmediate(memoryOperand[2]);
        const baseRegValue = parseRegisterValue(memoryOperand[3], regs);
        if (imm !== null && baseRegValue !== null) {
          body = `
            <div class="clike-loadstore">
              <div>${renderClikeExpression(formatClikeExpression(expression))}</div>
              <div class="clike-loadstore__comment">// ${escapeHtml(memoryOperand[3])} = ${hex32(baseRegValue)}, address = ${hex32(
                (baseRegValue + imm) >>> 0
              )}</div>
            </div>
          `;
        }
      }
    }

    const historyItems = history
      .slice(Math.max(0, historyIndex - 4), historyIndex)
      .map((entry) => entry.clike || entry.rv2c || "")
      .filter((entry) => entry.trim().length > 0)
      .reverse()
      .map(
        (entry, index) =>
          `<div class="clike-history__item" data-depth="${index}">${escapeHtml(entry.trim())}</div>`
      )
      .join("");

    return `
      <div class="clike-current">${body}</div>
      ${historyItems ? `<div class="clike-history">${historyItems}</div>` : ""}
    `;
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
    memoryView.applyEffects(effects, historyIndex);
    updateLastPc(effects);

    const previousEffects = historyIndex > 0 ? history[historyIndex - 1].effects ?? [] : [];
    clikeEl.innerHTML = renderPseudoCHtml(data);
    effectsEl.innerHTML = renderEffectLog();
    registersUi.render({
      regs: data.regs,
      effects,
      previousEffects,
      running: isRunning && (runSpeed === -1 || runSpeed > 500),
    });
    pcEl.textContent = data.pc !== undefined ? hex32(data.pc) : "";
    disasmEl.innerHTML = renderDisasm(data.pc, lastPc, data.disasm, disasmEncodings, breakpointManager.getAll(), data.regs);
    updateDisasmProgress(data);
    updateGoToPcButton(data.pc);

    const recentWrites = memoryView.getRecentWrites();
    memWritesEl.innerHTML = recentWrites.length
      ? recentWrites
          .map(
            (write) => `
              <div class="memory-write-item">
                <span class="memory-write-item__addr">${hex32(write.address)}</span>
                <span class="memory-write-item__before">${hex8(write.before)}</span>
                <span class="memory-write-item__arrow">→</span>
                <span class="memory-write-item__after">${hex8(write.after)}</span>
                <span class="memory-write-item__step">step ${write.step}</span>
              </div>
            `
          )
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
      setStatusDetails(stalled && !halted ? "Halted · stall detected" : "Halted", stalled && !halted ? "PC did not advance on the last step." : `Executed ${runStats.instructions} instructions · ${Math.round(runStats.elapsedMs)}ms`);
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
        setStatusDetails(`${baseMessage}${".".repeat(dots)}`, "Parsing source and preparing the local RV32IM session.");
        dots = dots === 3 ? 1 : dots + 1;
      };
      renderAssembleStatus();
      assembleTimer = window.setInterval(renderAssembleStatus, 500);
    } else {
      setStatusDetails("Resetting program…", "Reloading the assembled instructions into the simulator.");
    }

    stepBtn.disabled = true;
    stepBtn.textContent = "Step";
    runBtn.disabled = true;
    stopRun();

    try {
      const parsed = parseAssembly(sourceEl.value);
      currentParsedProgram = parsed;
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
      breakpointManager.resolveAddresses(parsed);
      editor.setBreakpoints(breakpointManager.getAll());
      renderBreakpointPanel();
      currentWarnings = lintProgram(sourceEl.value, parsed);
      updateWarningsPanel(currentWarnings);
      editor.setDiagnostics(diagnosticsFromWarnings(currentWarnings));
      runStats = {
        startedAt: 0,
        elapsedMs: 0,
        instructions: 0,
        cycles: 0,
      };
      updateRunStatsUi();

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
      setStatusDetails(
        successMessage || "Assembled",
        `${(disasmLines ?? []).filter((line) => !line.label).length} instructions · ${countLabelsInSource(sourceEl.value)} labels · ${currentWarnings.length} warnings`
      );
      setStatus("assembled");
      maybeShowClip("assemble-success", {
        totalInstructions: countExecutableInstructions(disasmLines),
        hasDataSegment: programDataBytes.length > 0,
        recursivePatternDetected: detectRecursivePattern(sourceEl.value),
      });
      succeeded = true;
    } catch (err) {
      const message = (err as Error).message;
      const lineMatch = /on line (\d+)/i.exec(message);
      currentParsedProgram = null;
      currentWarnings = [];
      updateWarningsPanel([]);
      editor.setDiagnostics(diagnosticFromAssemblyError(message));
      renderBreakpointPanel();
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
      setStatusDetails("Error", message);
      maybeShowClip("assemble-error", {
        errorMessage: message,
        errorLine: lineMatch ? Number(lineMatch[1]) : undefined,
      });
      pcEl.textContent = "";
      disasmEl.innerHTML = renderDisasm(undefined, undefined, []);
      clikeEl.innerHTML = renderClikeExpression(null);
      setCallStackExplainer("Step into a function to see the calling convention.");
      syncCallStackUi(stackTracker.getCallStack());
      resetAnimator();
      updateDisasmProgress();
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
    syncSampleOptionLabels();
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
    currentParsedProgram = null;
    currentWarnings = [];
    updateWarningsPanel([]);
    editor.clearDiagnostics();
    editor.setBreakpoints(breakpointManager.getAll());
    clearPanels();
    sessionId = undefined;
    disasmLines = [];
    clikeByPc = new Map<number, string>();
    disasmEncodings = new Map<number, string>();
    history = [];
    historyIndex = -1;
    runStats = {
      startedAt: 0,
      elapsedMs: 0,
      instructions: 0,
      cycles: 0,
    };
    updateRunStatsUi();
    stopRun();
    stopAssembleSpinner();
    setAnimationsEnabled(true);
    resetAnimator();
    setStatusDetails(runtime ? options.statusMessage ?? "Ready" : "Initializing Rust/WASM simulator…", runtime ? "" : "Loading the WebAssembly engine.");
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

  const lessonMode = createLessonMode({
    loadSource(source, options = {}) {
      applyEditorSource(source, {
        statusMessage: options.statusMessage ?? "",
        focus: options.focus ?? false,
      });
    },
    assembleSource(showSpinner, successMessage) {
      return assembleCurrentSource(showSpinner, successMessage);
    },
    getExecutionDeltas() {
      return history.slice(1, historyIndex + 1).map(snapshotToDelta);
    },
    getInstructionCount() {
      const lines = disasmLines ?? [];
      return new Set(lines.map((line) => line.pc >>> 0)).size;
    },
    getInstructionText(pc) {
      const lines = disasmLines ?? [];
      return lines.find((line) => (line.pc >>> 0) === (pc >>> 0))?.text ?? "";
    },
    getCurrentSession() {
      return currentUserSession;
    },
    stepForward() {
      stepBtn.click();
    },
    setEditorReadOnly(readOnly) {
      editor.setReadOnly(readOnly);
    },
    showToast(message) {
      showToast(message);
    },
    setStatusMessage(message) {
      setStatusDetails(message, statusSecondaryEl?.textContent ?? "");
    },
  });

  const challengeMode = createChallengeMode({
    loadSource(source, options = {}) {
      applyEditorSource(source, {
        statusMessage: options.statusMessage ?? "",
        focus: options.focus ?? false,
      });
    },
    assembleSource(showSpinner, successMessage) {
      return assembleCurrentSource(showSpinner, successMessage);
    },
    getCurrentSession() {
      return currentUserSession;
    },
    getSource() {
      return sourceEl.value;
    },
    showToast(message) {
      showToast(message);
    },
    setStatusMessage(message) {
      setStatusDetails(message, statusSecondaryEl?.textContent ?? "");
    },
  });

  const labMode = createLabMode({
    loadSource(source, options = {}) {
      applyEditorSource(source, {
        statusMessage: options.statusMessage ?? "",
        focus: options.focus ?? false,
      });
    },
    assembleSource(showSpinner, successMessage) {
      return assembleCurrentSource(showSpinner, successMessage);
    },
    getCurrentSession() {
      return currentUserSession;
    },
    getSource() {
      return sourceEl.value;
    },
    showToast(message) {
      showToast(message);
    },
    setStatusMessage(message) {
      setStatusDetails(message, statusSecondaryEl?.textContent ?? "");
    },
  });

  const activeLearningMode = challengeMode.isActive()
    ? challengeMode
    : labMode.isActive()
      ? labMode
      : lessonMode;

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
      setStatusDetails(message, statusSecondaryEl?.textContent ?? "");
      showToast(message);
    },
  });
  syncCurrentProgramUi();

  centerTabButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const tabId = button.dataset.centerTab as CenterTabId | undefined;
      if (!tabId) {
        return;
      }
      setActiveCenterTab(tabId);
    });
  });

  setActiveCenterTab("disassembly");
  setStatus("ready");
  updateRunSpeedUi();
  if (runSpeedPanelEl) {
    runSpeedPanelEl.hidden = false;
  }
  try {
    if (window.localStorage.getItem("studyriscv_hints_dismissed")) {
      removeShortcutHintsBar();
    }
  } catch {
    // Ignore storage failures and leave the bar visible.
  }
  currentUserSession = await initAuthUi({
    onSession(session) {
      currentUserSession = session;
      void programsUi?.setSession(session);
      void activeLearningMode.handleSessionChange(session);
    },
  });
  await programsUi?.setSession(currentUserSession);
  await activeLearningMode.handleSessionChange(currentUserSession);

  sourceEl.addEventListener("input", handleSourceInput);
  sourceEl.addEventListener("keyup", updateLineNumbers);
  sourceEl.addEventListener("click", updateLineNumbers);
  sourceEl.addEventListener("scroll", () => {
    updateLineNumbers();
    syncHighlightScroll();
  });
  sourceEl.addEventListener("focus", updateLineNumbers);

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

  runSpeedEl?.addEventListener("input", () => {
    runSpeed = RUN_SPEED_PRESETS[Number(runSpeedEl.value)] ?? 100;
    persistRunSpeed();
    updateRunSpeedUi();
  });

  shortcutHintDismissBtn?.addEventListener("click", () => {
    const hintsBar =
      shortcutHintBarEl ??
      document.querySelector<HTMLElement>(".hints-bar") ??
      document.querySelector<HTMLElement>("[class*='hint-bar']") ??
      document.querySelector<HTMLElement>("[class*='shortcuts-bar']") ??
      document.querySelector<HTMLElement>("[class*='keyboard-hint']");
    if (hintsBar) {
      hintsBar.style.transition = "opacity 200ms ease";
      hintsBar.style.opacity = "0";
      window.setTimeout(() => {
        hintsBar.remove();
      }, 200);
    }
    try {
      window.localStorage.setItem("studyriscv_hints_dismissed", "1");
    } catch {
      // Ignore storage failures.
    }
  });

  warningsToggleBtn?.addEventListener("click", () => {
    warningsExpanded = !warningsExpanded;
    updateWarningsPanel(currentWarnings);
  });

  breakpointsClearAllBtn?.addEventListener("click", () => {
    breakpointManager.clear();
    editor.setBreakpoints([]);
    renderBreakpointPanel();
    if (currentParsedProgram) {
      breakpointManager.resolveAddresses(currentParsedProgram);
    }
  });

  breakpointsListEl?.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-breakpoint-id]");
    if (!target) {
      return;
    }
    breakpointManager.remove(target.dataset.breakpointId ?? "");
    editor.setBreakpoints(breakpointManager.getAll());
    renderBreakpointPanel();
  });

  sourceLinesEl?.addEventListener("contextmenu", (event) => {
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-line]");
    if (!target) {
      return;
    }
    const line = Number(target.dataset.line);
    if (!breakpointManager.getByLine(line)) {
      return;
    }
    event.preventDefault();
    openBreakpointConditionEditor(line, target.getBoundingClientRect());
  });

  document.addEventListener("click", (event) => {
    const target = event.target as Node | null;
    if (!target) {
      return;
    }
    if (breakpointConditionPopoverEl?.hidden === false && !breakpointConditionPopoverEl.contains(target)) {
      closeBreakpointConditionEditor();
    }
  });

  goToPcBtn?.addEventListener("click", () => {
    const currentPc = currentSnapshot()?.pc;
    if (currentPc === undefined) {
      return;
    }
    const row = disasmEl.querySelector<HTMLElement>(`[data-pc="${currentPc >>> 0}"]`);
    row?.scrollIntoView({ block: "center", behavior: "smooth" });
  });

  disasmEl.addEventListener("scroll", () => {
    updateGoToPcButton(currentSnapshot()?.pc);
  });

  memoryModeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      memoryMode = (button.dataset.memoryMode as MemoryViewMode) || "bytes";
      memoryModeButtons.forEach((candidate) => candidate.classList.toggle("is-active", candidate === button));
      updateMemoryWindow(currentSnapshot()?.regs);
    });
  });

  memoryWordFormatButtons.forEach((button) => {
    button.addEventListener("click", () => {
      memoryWordFormat = (button.dataset.memoryWordFormat as MemoryWordFormat) || "hex";
      memoryWordFormatButtons.forEach((candidate) => candidate.classList.toggle("is-active", candidate === button));
      updateMemoryWindow(currentSnapshot()?.regs);
    });
  });

  function commitWatchAddress() {
    if (!memWatchInput) {
      return;
    }
    const raw = memWatchInput.value.trim();
    const normalized = raw.startsWith("0x") || raw.startsWith("0X") ? raw.slice(2) : raw;
    if (!/^[0-9a-fA-F]+$/.test(normalized)) {
      return;
    }
    const parsed = Number.parseInt(normalized, 16);
    if (!Number.isFinite(parsed)) {
      return;
    }
    const next = Array.from(new Set([...memoryWatches, parsed >>> 0])).slice(0, 4);
    memoryWatches = next;
    memoryView.setWatchedAddresses(memoryWatches);
    memWatchInput.value = "";
    updateMemoryWindow(currentSnapshot()?.regs);
  }

  memWatchAddBtn?.addEventListener("click", commitWatchAddress);
  memWatchInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitWatchAddress();
    }
  });

  memWatchesEl?.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-remove-watch]");
    if (!target) {
      return;
    }
    const address = Number(target.dataset.removeWatch ?? "-1");
    memoryWatches = memoryWatches.filter((candidate) => candidate !== address);
    memoryView.setWatchedAddresses(memoryWatches);
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

  const sharedProgram = activeLearningMode.isActive() ? null : await readFromUrl();
  if (activeLearningMode.isActive()) {
    setSharedBannerVisible(false);
    activeLearningMode.prefillSource();
  } else if (sharedProgram) {
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

  setStatusDetails("Initializing Rust/WASM simulator…", "Loading the local RV32IM runtime.");
  assembleBtn.disabled = true;
  WasmRuntime.create()
    .then(async (rt) => {
      runtime = rt;
      rt.setAlignmentChecks(true);
      setStatusDetails("Ready", "Rust/WASM simulator ready.");
      assembleBtn.disabled = false;
      if (activeLearningMode.isActive()) {
        await activeLearningMode.initialize();
      } else if (sharedProgram) {
        await assembleCurrentSource(true, "Loaded from shared link.");
      }
    })
    .catch((err) => {
      setStatusDetails("Initialization failed", `Failed to initialize WASM: ${(err as Error).message}`);
      assembleBtn.disabled = true;
      setStatus("ready");
    });

  assembleBtn.onclick = async () => {
    const assembled = await assembleCurrentSource(true, "Program assembled. Ready to step.");
    if (assembled) {
      activeLearningMode.handleAssembled();
    }
    if (assembled && currentUserSession?.isGtStudent) {
      programsUi?.recordHistory(sourceEl.value);
    }
  };

  resetBtn.onclick = async () => {
    resetCurrentProgramState();
    const assembled = await assembleCurrentSource(false, "Program reset.");
    if (assembled) {
      activeLearningMode.handleReset();
    }
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
    setStatusDetails("Viewing previous state", "Use Step to move forward again or Reset to reassemble.");
    activeLearningMode.handleStepBack();
    maybeShowClip("step-back", {});
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
      maybeSwitchToDisassembly(history[historyIndex].effects ?? []);
      setStatusDetails("Viewing recorded state", "This is a previously executed snapshot from the current run.");
      setStatus("assembled");
      activeLearningMode.handleStep(false);
      return;
    }

    try {
      setStatus("stepping");
      const stepStartedAt = performance.now();
      const previousSnapshot = currentSnapshot();
      const previousRegs = previousSnapshot?.regs ? Array.from(previousSnapshot.regs) : runtime.readRegisters();
      const previousPc = previousSnapshot?.pc ?? runtime.pc();
      const executedInstruction = instructionTextForPc(previousPc);
      const executedMnemonic = instructionMnemonic(executedInstruction);
      const beforeCallStack = stackTracker.getCallStack();
      const delta = runtime.step();
      const data = buildSnapshot(delta);
      pushHistory(data);
      runStats.instructions += 1;
      runStats.cycles += 1;
      runStats.elapsedMs += performance.now() - stepStartedAt;
      updateRunStatsUi();
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
      maybeSwitchToDisassembly(delta.effects);
      setCallStackExplainer(buildCallStackExplainer(beforeCallStack, afterCallStack));
      renderCallStack(afterCallStack);
      if (pushedFrame) {
        flashCenterTab("call-stack");
      }
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
        setStatusDetails(
          `Step ${historyIndex} of ${Math.max(1, (disasmLines ?? []).filter((line) => !line.label).length)}`,
          `PC = ${hex32(data.pc ?? 0)} · sp = ${hex32(data.regs?.[2] ?? 0)}`
        );
        setStatus("stepping");
      }
      recordClipStep();
      const changedReg = findChangedRegister(data.regs, previousRegs);
      const branchInstruction = ["beq", "bne", "blt", "bge", "bltu", "bgeu"].includes(executedMnemonic);
      maybeShowClip("step", {
        pc: data.pc,
        registers: data.regs,
        prevRegisters: previousRegs,
        spDelta: (data.regs?.[2] ?? 0) - (previousRegs?.[2] ?? 0),
        raDelta: (data.regs?.[1] ?? 0) !== (previousRegs?.[1] ?? 0),
        changedReg,
        changedRegValue: changedReg !== undefined ? data.regs?.[changedReg] : undefined,
        branchTaken: branchInstruction && ((data.pc ?? 0) >>> 0) !== (((previousPc ?? 0) + 4) >>> 0),
        branchNotTaken: branchInstruction && ((data.pc ?? 0) >>> 0) === (((previousPc ?? 0) + 4) >>> 0),
        destIsX0: destRegisterForInstruction(executedInstruction) === 0,
        instructionType: executedMnemonic,
        instructionText: executedInstruction,
        stepNumber: runStats.instructions,
        totalInstructions: countExecutableInstructions(disasmLines),
      });
      activeLearningMode.handleStep(true);
    } catch (err) {
      setPanelMessage(effectsEl, `Error: ${(err as Error).message}`, "danger");
      setStatusDetails("Error", (err as Error).message);
      setStatus("ready");
    }
  };

  runBtn.onclick = async () => {
    if (isRunning) {
      runRequested = false;
      return;
    }
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

    runStats = {
      startedAt: performance.now(),
      elapsedMs: 0,
      instructions: 0,
      cycles: 0,
    };
    updateRunStatsUi();
    assembleBtn.disabled = true;
    stepBtn.disabled = true;
    resetBtn.disabled = true;
    runBtn.disabled = false;
    runBtn.textContent = "Stop";
    isRunning = true;
    runRequested = true;
    latestRenderAt = 0;
    setStatusDetails("Running", "Executing locally in the browser via WASM.");
    setStatus("running");
    setAnimationsEnabled(false);
    registersUi.setRunningOverlay(runSpeed === -1 || runSpeed > 500);

    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });

    let lastDelta: WasmStateDelta | null = null;
    let finalMessage = `Run stopped after ${MAX_RUN_STEPS} steps.`;
    let stoppedAtBreakpoint = false;
    const initialRegs = activeRuntime.readRegisters();
    let skipBreakpointPc = breakpointManager.isBreakpointAt(activeRuntime.pc(), initialRegs) ? activeRuntime.pc() : null;

    try {
      await new Promise<void>((resolve) => {
        const tick = () => {
          const speed = runSpeed;
          const batchSize =
            speed === -1 ? 300 : speed > 500 ? 120 : speed <= 50 ? 1 : Math.max(2, Math.round(speed / 10));
          let shouldRender = speed <= 50;

          for (let batchIndex = 0; batchIndex < batchSize; batchIndex += 1) {
            if (!runRequested) {
              finalMessage = "Run paused.";
              break;
            }
            if (runStats.instructions >= MAX_RUN_STEPS) {
              finalMessage = `Run stopped after ${MAX_RUN_STEPS} steps.`;
              runRequested = false;
              break;
            }

            const currentPc = activeRuntime.pc();
            const ignoreCurrentBreakpoint = skipBreakpointPc !== null && currentPc === skipBreakpointPc;
            const currentRegs = activeRuntime.readRegisters();
            const breakpoint = breakpointForPc(currentPc, currentRegs);
            if (!ignoreCurrentBreakpoint && breakpoint) {
              breakpointManager.recordHit(currentPc);
              renderBreakpointPanel();
              finalMessage = `Paused at breakpoint · Line ${breakpoint?.line ?? "?"} · ${hex32(currentPc)}`;
              showBreakpointTooltip(`Breakpoint hit at ${hex32(currentPc)} · Line ${breakpoint?.line ?? "?"}`);
              maybeShowClip("run-breakpoint", { pc: currentPc });
              runRequested = false;
              stoppedAtBreakpoint = true;
              shouldRender = true;
              break;
            }
            skipBreakpointPc = null;

            const delta = activeRuntime.step();
            lastDelta = delta;
            const data = buildSnapshot(delta);
            pushHistory(data);
            stackTracker.applyDelta(delta);
            runStats.instructions += 1;
            runStats.cycles += 1;
            runStats.elapsedMs = performance.now() - runStats.startedAt;

            if (data.trap) {
              finalMessage = fmtTrap(data.trap);
              runRequested = false;
              shouldRender = true;
              break;
            }
            if (data.halted) {
              finalMessage = "Program halted.";
              runRequested = false;
              shouldRender = true;
              break;
            }
            if (isPcStalled(data.effects ?? [])) {
              finalMessage = "Halt loop detected.";
              runRequested = false;
              shouldRender = true;
              break;
            }
          }

          const now = performance.now();
          if (speed > 50 && speed <= 500 && now - latestRenderAt >= 100) {
            shouldRender = true;
          }
          if ((speed > 500 || speed === -1) && now - latestRenderAt >= 200) {
            shouldRender = true;
          }

          if (shouldRender && historyIndex >= 0) {
            renderFromHistory(historyIndex);
            updateRunStatsUi();
            latestRenderAt = now;
          } else {
            updateRunStatsUi();
          }

          if (!runRequested) {
            resolve();
            return;
          }

          if (speed <= 50) {
            window.setTimeout(tick, Math.max(1, Math.round(1000 / speed)));
            return;
          }
          if (speed <= 500) {
            window.setTimeout(tick, 100);
            return;
          }
          window.requestAnimationFrame(tick);
        };

        tick();
      });

      stopRun();
      if (historyIndex >= 0) {
        renderFromHistory(historyIndex);
      }
      updateRunStatsUi();
      setStatusDetails(finalMessage, `Executed ${runStats.instructions} instructions · ${Math.round(runStats.elapsedMs)}ms`);
      if (!stoppedAtBreakpoint && finalMessage !== "Run paused.") {
        const finalTrap = currentSnapshot()?.trap ?? null;
        maybeShowClip("run-halt", {
          pc: currentSnapshot()?.pc,
          stepNumber: runStats.instructions,
          errorMessage: finalTrap ? fmtTrap(finalTrap) : undefined,
        });
      }
      activeLearningMode.handleRunEnd();
      setAnimationsEnabled(true);
      const finalDelta = historyIndex >= 0 ? snapshotToDelta(history[historyIndex]) : lastDelta;
      if (finalDelta) {
        animateStep(finalDelta);
        if (!finalDelta.halted && !finalDelta.trap && !isPcStalled(finalDelta.effects ?? [])) {
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
      resetBtn.disabled = !sessionId;
      setStatus("ready");
      return;
    }

    assembleBtn.disabled = false;
    resetBtn.disabled = !sessionId;
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
