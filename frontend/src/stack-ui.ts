import { escapeHtml, hex32 } from "./format";
import type { CallStack, StackFrame } from "./stack-tracker";
import { stackFrameKey } from "./stack-tracker";

const IDLE_EXPLAINER = "Step into a function to see the calling convention.";

type RenderRefs = {
  stackView: HTMLElement;
  legendToggle: HTMLButtonElement;
  legendBody: HTMLElement;
  explainer: HTMLElement;
};

type SlotDescriptor = {
  address: number;
  value: number;
  content: string;
  role: string;
  type: "ra" | "saved" | "local";
};

let refs: RenderRefs | null = null;
let initialized = false;
let legendCollapsed = true;
let explainerText = IDLE_EXPLAINER;
let placeholderLabel = "main";
let currentCallStack: CallStack = {
  frames: [],
  spCurrent: 0x7ffffffc,
  spInitial: 0x7ffffffc,
  totalDepth: 0,
};
let previousCallStack: CallStack | null = null;
let renderQueued = false;
const expandedFrames = new Set<string>();

function cloneCallStack(callStack: CallStack): CallStack {
  return {
    frames: callStack.frames.map((frame) => ({
      functionLabel: frame.functionLabel,
      baseAddress: frame.baseAddress >>> 0,
      returnAddress: frame.returnAddress,
      savedRegisters: frame.savedRegisters.map((saved) => ({
        reg: saved.reg,
        name: saved.name,
        value: saved.value >>> 0,
        address: saved.address >>> 0,
      })),
      localSlots: frame.localSlots.map((slot) => ({
        address: slot.address >>> 0,
        value: slot.value >>> 0,
        label: slot.label,
      })),
      entryPc: frame.entryPc >>> 0,
      isLeaf: frame.isLeaf,
    })),
    spCurrent: callStack.spCurrent >>> 0,
    spInitial: callStack.spInitial >>> 0,
    totalDepth: callStack.totalDepth,
  };
}

function getRefs(): RenderRefs | null {
  if (refs) {
    return refs;
  }

  const stackView = document.getElementById("callStackView") as HTMLElement | null;
  const legendToggle = document.getElementById("stackLegendToggle") as HTMLButtonElement | null;
  const legendBody = document.getElementById("stackLegendBody") as HTMLElement | null;
  const explainer = document.getElementById("stackExplainer") as HTMLElement | null;

  if (!stackView || !legendToggle || !legendBody || !explainer) {
    return null;
  }

  refs = {
    stackView,
    legendToggle,
    legendBody,
    explainer,
  };

  return refs;
}

function renderLegend(): string {
  return `
    <div class="stack-legend-grid">
      <div class="stack-legend-column">
        <div class="stack-legend-heading">Caller-saved (may change)</div>
        <div class="stack-legend-item">
          <span class="stack-legend-pill stack-legend-pill--warning">ra (x1)</span>
          <span class="stack-legend-copy">return address</span>
        </div>
        <div class="stack-legend-item">
          <span class="stack-legend-pill stack-legend-pill--accent">a0-a7</span>
          <span class="stack-legend-copy">arguments / return values</span>
        </div>
        <div class="stack-legend-item">
          <span class="stack-legend-pill stack-legend-pill--muted">t0-t6</span>
          <span class="stack-legend-copy">temporaries</span>
        </div>
      </div>
      <div class="stack-legend-column">
        <div class="stack-legend-heading">Callee-saved (preserved)</div>
        <div class="stack-legend-item">
          <span class="stack-legend-pill stack-legend-pill--danger">sp (x2)</span>
          <span class="stack-legend-copy">stack pointer</span>
        </div>
        <div class="stack-legend-item">
          <span class="stack-legend-pill stack-legend-pill--success">s0-s11</span>
          <span class="stack-legend-copy">saved registers</span>
        </div>
        <div class="stack-legend-item">
          <span class="stack-legend-pill stack-legend-pill--muted">gp (x3)</span>
          <span class="stack-legend-copy">global pointer</span>
        </div>
      </div>
    </div>
  `;
}

function syncChrome(): void {
  const dom = getRefs();
  if (!dom) {
    return;
  }

  dom.legendBody.hidden = legendCollapsed;
  dom.legendToggle.setAttribute("aria-expanded", String(!legendCollapsed));
  dom.legendToggle.classList.toggle("is-collapsed", legendCollapsed);
  dom.explainer.textContent = explainerText;
}

function initialize(): boolean {
  if (initialized) {
    return true;
  }

  const dom = getRefs();
  if (!dom) {
    return false;
  }

  dom.legendToggle.addEventListener("click", () => {
    legendCollapsed = !legendCollapsed;
    syncChrome();
  });

  dom.stackView.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-frame-toggle]") : null;
    if (!target) {
      return;
    }

    const key = target.dataset.frameToggle;
    if (!key) {
      return;
    }

    if (expandedFrames.has(key)) {
      expandedFrames.delete(key);
    } else {
      expandedFrames.add(key);
    }
    flushRender(true);
  });

  dom.legendBody.innerHTML = renderLegend();
  initialized = true;
  syncChrome();
  return true;
}

function collectSlots(frame: StackFrame): SlotDescriptor[] {
  const saved = frame.savedRegisters.map<SlotDescriptor>((savedRegister) => ({
    address: savedRegister.address >>> 0,
    value: savedRegister.value >>> 0,
    content:
      savedRegister.reg === 1
        ? hex32(savedRegister.value)
        : `${escapeHtml(savedRegister.name)} = ${hex32(savedRegister.value)}`,
    role: savedRegister.reg === 1 ? "saved ra" : "saved reg",
    type: savedRegister.reg === 1 ? "ra" : "saved",
  }));
  const locals = frame.localSlots.map<SlotDescriptor>((slot) => ({
    address: slot.address >>> 0,
    value: slot.value >>> 0,
    content: hex32(slot.value),
    role: slot.label || "local",
    type: "local",
  }));

  return [...saved, ...locals].sort((left, right) => right.address - left.address);
}

function slotMap(frame: StackFrame | undefined): Map<number, SlotDescriptor> {
  return new Map((frame ? collectSlots(frame) : []).map((slot) => [slot.address, slot]));
}

function frameIndex(callStack: CallStack, frame: StackFrame): number {
  return callStack.frames.findIndex((candidate) => stackFrameKey(candidate) === stackFrameKey(frame));
}

function frameFloor(callStack: CallStack, frame: StackFrame): number {
  const index = frameIndex(callStack, frame);
  if (index < 0) {
    return callStack.spCurrent >>> 0;
  }
  return index === callStack.frames.length - 1 ? callStack.spCurrent >>> 0 : callStack.frames[index + 1].baseAddress >>> 0;
}

function frameSize(callStack: CallStack, frame: StackFrame): number {
  return (frame.baseAddress >>> 0) - frameFloor(callStack, frame);
}

function safeFrameSize(callStack: CallStack, frame: StackFrame): number | null {
  const size = frameSize(callStack, frame);
  return Number.isFinite(size) && size >= 0 && size <= 4096 ? size : null;
}

function frameSizeLabel(callStack: CallStack, frame: StackFrame): string {
  const size = safeFrameSize(callStack, frame);
  return size === null ? "" : `${size} bytes`;
}

function isRenderableFrame(callStack: CallStack, frame: StackFrame): boolean {
  return collectSlots(frame).length > 0 || (safeFrameSize(callStack, frame) ?? 0) > 0;
}

function renderSlotRows(frame: StackFrame, previousFrame?: StackFrame): string {
  const previousSlots = slotMap(previousFrame);
  return collectSlots(frame)
    .map((slot) => {
      const previousSlot = previousSlots.get(slot.address);
      const rowClasses = ["stack-slot-row", `slot-${slot.type}`];
      if (!previousSlot) {
        rowClasses.push("stack-slot-row--new");
      } else if (previousSlot.value !== slot.value || previousSlot.type !== slot.type) {
        rowClasses.push("stack-slot-row--updated");
      }

      return `
        <div
          class="${rowClasses.join(" ")}"
          data-slot-address="${slot.address >>> 0}"
          data-address-ruler="${hex32(slot.address)}"
        >
          <span class="stack-slot-address">${hex32(slot.address)}</span>
          <span class="stack-slot-content">${slot.content}</span>
          <span class="stack-slot-role">${escapeHtml(slot.role)}</span>
        </div>
      `;
    })
    .join("");
}

function renderSpRow(frame: StackFrame, callStack: CallStack, isCurrentFrame: boolean): string {
  const classes = ["stack-sp-row"];
  if (isCurrentFrame) {
    classes.push("stack-sp-row--current");
  }
  const spValue = isCurrentFrame ? callStack.spCurrent >>> 0 : frameFloor(callStack, frame);

  return `
    <div
      class="${classes.join(" ")}"
      data-sp-frame-key="${escapeHtml(stackFrameKey(frame))}"
      data-address-ruler="${hex32(spValue)}"
    >
      <span class="stack-sp-arrow" aria-hidden="true">→</span>
      <span class="stack-sp-label">sp</span>
      <span class="stack-sp-value">${hex32(spValue)}</span>
    </div>
  `;
}

function renderFrameBody(frame: StackFrame, callStack: CallStack, previousFrame?: StackFrame, isCurrentFrame = false): string {
  return `
    <div class="stack-frame-body">
      ${renderSlotRows(frame, previousFrame)}
      ${renderSpRow(frame, callStack, isCurrentFrame)}
    </div>
  `;
}

function renderExpandedFrame(
  frame: StackFrame,
  callStack: CallStack,
  previousFrame: StackFrame | undefined,
  options: { current: boolean; ghost?: boolean }
): string {
  const key = stackFrameKey(frame);
  const header = options.current
    ? `
        <div class="stack-frame-header stack-frame-header--active">
          <span class="stack-frame-name">${escapeHtml(frame.functionLabel)}</span>
          <span class="stack-frame-size">${escapeHtml(frameSizeLabel(callStack, frame))}</span>
        </div>
      `
    : `
        <button
          type="button"
          class="stack-frame-header"
          data-frame-toggle="${escapeHtml(key)}"
          aria-expanded="true"
        >
          <span class="stack-frame-name">${escapeHtml(frame.functionLabel)}</span>
          <span class="stack-frame-size">${escapeHtml(frameSizeLabel(callStack, frame))}</span>
        </button>
      `;

  const frameClasses = ["stack-frame-block"];
  if (options.current) {
    frameClasses.push("stack-frame-block--current");
  }
  if (options.ghost) {
    frameClasses.push("stack-frame-block--ghost");
  }

  return `
    <section
      class="${frameClasses.join(" ")}"
      data-frame-key="${escapeHtml(key)}"
      ${options.ghost ? 'data-popping="true"' : ""}
    >
      ${header}
      ${renderFrameBody(frame, callStack, previousFrame, options.current)}
    </section>
  `;
}

function renderCompressedFrame(frame: StackFrame, callStack: CallStack): string {
  const key = stackFrameKey(frame);
  const returnAddress =
    frame.returnAddress < 0 ? "entry" : `ra ${hex32(frame.returnAddress)}`;
  const sizeLabel = frameSizeLabel(callStack, frame);
  return `
    <button
      type="button"
      class="stack-frame-header stack-frame-header--compressed"
      data-frame-toggle="${escapeHtml(key)}"
      aria-expanded="false"
    >
      <span class="stack-frame-summary">
        <span class="stack-frame-name">${escapeHtml(frame.functionLabel)}</span>
        <span class="stack-frame-size">${escapeHtml(sizeLabel)}</span>
        <span class="stack-frame-return">${escapeHtml(returnAddress)}</span>
      </span>
      <span class="stack-frame-chevron" aria-hidden="true">⌄</span>
    </button>
  `;
}

function renderEmptyState(callStack: CallStack): string {
  return `
    <div class="stack-empty-state" aria-label="${escapeHtml(placeholderLabel)} stack frame placeholder">
      sp = ${hex32(callStack.spCurrent)} · No active frames
    </div>
  `;
}

function renderFrames(callStack: CallStack, includeDiff: boolean): string {
  const ghostFrame =
    includeDiff &&
    previousCallStack &&
    previousCallStack.frames.length > callStack.frames.length
      ? previousCallStack.frames[previousCallStack.frames.length - 1]
      : undefined;

  const visibleFrames = callStack.frames.filter((frame) => isRenderableFrame(callStack, frame));

  if (visibleFrames.length === 0) {
    return `
      <div class="stack-frames-canvas">
        <div class="stack-frames-scroll">
          ${
            ghostFrame
              ? renderExpandedFrame(ghostFrame, previousCallStack ?? callStack, ghostFrame, {
                  current: false,
                  ghost: true,
                })
              : ""
          }
          ${renderEmptyState(callStack)}
        </div>
      </div>
    `;
  }

  const previousByKey = new Map<string, StackFrame>(
    (previousCallStack?.frames ?? []).map((frame) => [stackFrameKey(frame), frame])
  );
  const newestFirst = [...visibleFrames].reverse();
  const currentFrame = newestFirst[0];
  const olderFrames = newestFirst.slice(1);

  return `
    <div class="stack-frames-canvas">
      <div class="stack-frames-scroll">
        ${
          ghostFrame
            ? renderExpandedFrame(ghostFrame, previousCallStack ?? callStack, ghostFrame, {
                current: false,
                ghost: true,
              })
            : ""
        }
        ${renderExpandedFrame(currentFrame, callStack, previousByKey.get(stackFrameKey(currentFrame)), { current: true })}
        ${olderFrames
          .map((frame) => {
            const key = stackFrameKey(frame);
            return expandedFrames.has(key)
              ? renderExpandedFrame(frame, callStack, previousByKey.get(key), { current: false })
              : renderCompressedFrame(frame, callStack);
          })
          .join("")}
      </div>
    </div>
  `;
}

function flushRender(includeDiff: boolean): void {
  renderQueued = false;
  if (!initialize()) {
    return;
  }

  const dom = getRefs();
  if (!dom) {
    return;
  }

  dom.stackView.innerHTML = renderFrames(currentCallStack, includeDiff);
  previousCallStack = cloneCallStack(currentCallStack);
  syncChrome();
}

export function setCallStackPlaceholder(label: string): void {
  placeholderLabel = label || "main";
  syncChrome();
}

export function setCallStackExplainer(text: string): void {
  explainerText = text || IDLE_EXPLAINER;
  syncChrome();
}

export function syncCallStackUi(callStack: CallStack): void {
  currentCallStack = cloneCallStack(callStack);
  previousCallStack = cloneCallStack(callStack);
  flushRender(false);
}

export function renderCallStack(callStack: CallStack): void {
  currentCallStack = cloneCallStack(callStack);
  if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
    flushRender(true);
    return;
  }

  if (renderQueued) {
    return;
  }

  renderQueued = true;
  window.requestAnimationFrame(() => flushRender(true));
}
