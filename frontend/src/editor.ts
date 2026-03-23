import { escapeHtml } from "./format";
import type { Breakpoint } from "./breakpoints";

type EditorDiagnostic = {
  line: number;
  col?: number;
  code: string;
  message: string;
  severity: "warning" | "error" | "info";
};

type CompletionItem = {
  kind: "mnemonic" | "register";
  label: string;
  detail: string;
  hover?: string;
};

type EditorConfig = {
  container: HTMLElement;
  textarea: HTMLTextAreaElement;
  lineNumbers: HTMLElement;
  highlightDisplay: HTMLElement;
  onGutterClick?: (line: number) => void;
};

const MNEMONIC_DETAILS: Array<{ label: string; detail: string; hover?: string }> = [
  { label: "add", detail: "add rd, rs1, rs2" },
  { label: "addi", detail: "addi rd, rs1, imm" },
  { label: "sub", detail: "sub rd, rs1, rs2" },
  { label: "lui", detail: "lui rd, imm20" },
  { label: "auipc", detail: "auipc rd, imm20" },
  { label: "and", detail: "and rd, rs1, rs2" },
  { label: "andi", detail: "andi rd, rs1, imm" },
  { label: "or", detail: "or rd, rs1, rs2" },
  { label: "ori", detail: "ori rd, rs1, imm" },
  { label: "xor", detail: "xor rd, rs1, rs2" },
  { label: "xori", detail: "xori rd, rs1, imm" },
  { label: "sll", detail: "sll rd, rs1, rs2" },
  { label: "slli", detail: "slli rd, rs1, shamt" },
  { label: "srl", detail: "srl rd, rs1, rs2" },
  { label: "srli", detail: "srli rd, rs1, shamt" },
  { label: "sra", detail: "sra rd, rs1, rs2" },
  { label: "srai", detail: "srai rd, rs1, shamt" },
  { label: "slt", detail: "slt rd, rs1, rs2" },
  { label: "slti", detail: "slti rd, rs1, imm" },
  { label: "sltu", detail: "sltu rd, rs1, rs2" },
  { label: "sltiu", detail: "sltiu rd, rs1, imm" },
  { label: "lw", detail: "lw rd, imm(rs1)" },
  { label: "lh", detail: "lh rd, imm(rs1)" },
  { label: "lb", detail: "lb rd, imm(rs1)" },
  { label: "lhu", detail: "lhu rd, imm(rs1)" },
  { label: "lbu", detail: "lbu rd, imm(rs1)" },
  { label: "sw", detail: "sw rs2, imm(rs1)" },
  { label: "sh", detail: "sh rs2, imm(rs1)" },
  { label: "sb", detail: "sb rs2, imm(rs1)" },
  { label: "beq", detail: "beq rs1, rs2, label" },
  { label: "bne", detail: "bne rs1, rs2, label" },
  { label: "blt", detail: "blt rs1, rs2, label" },
  { label: "bge", detail: "bge rs1, rs2, label" },
  { label: "bltu", detail: "bltu rs1, rs2, label" },
  { label: "bgeu", detail: "bgeu rs1, rs2, label" },
  { label: "jal", detail: "jal rd, label" },
  { label: "jalr", detail: "jalr rd, imm(rs1)" },
  { label: "mul", detail: "mul rd, rs1, rs2" },
  { label: "mulh", detail: "mulh rd, rs1, rs2" },
  { label: "mulhu", detail: "mulhu rd, rs1, rs2" },
  { label: "mulhsu", detail: "mulhsu rd, rs1, rs2" },
  { label: "div", detail: "div rd, rs1, rs2" },
  { label: "divu", detail: "divu rd, rs1, rs2" },
  { label: "rem", detail: "rem rd, rs1, rs2" },
  { label: "remu", detail: "remu rd, rs1, rs2" },
  { label: "ecall", detail: "ecall" },
  { label: "ebreak", detail: "ebreak" },
  { label: "li", detail: "li rd, imm", hover: "li rd, imm  →  addi rd, x0, imm (small)" },
  { label: "mv", detail: "mv rd, rs", hover: "mv rd, rs  →  addi rd, rs, 0" },
  { label: "la", detail: "la rd, label", hover: "la rd, label  →  auipc + addi" },
  { label: "nop", detail: "nop", hover: "nop  →  addi x0, x0, 0" },
  { label: "j", detail: "j label", hover: "j label  →  jal x0, label" },
  { label: "ret", detail: "ret", hover: "ret  →  jalr x0, ra, 0" },
  { label: "call", detail: "call label", hover: "call label  →  auipc ra, hi20; jalr ra, lo12(ra)" },
];

const REGISTER_ALIASES: Array<{ label: string; detail: string }> = [
  { label: "zero", detail: "x0 · always 0" },
  { label: "ra", detail: "x1 · return address" },
  { label: "sp", detail: "x2 · stack pointer" },
  { label: "gp", detail: "x3 · global pointer" },
  { label: "tp", detail: "x4 · thread pointer" },
  { label: "t0", detail: "x5 · temp" },
  { label: "t1", detail: "x6 · temp" },
  { label: "t2", detail: "x7 · temp" },
  { label: "s0", detail: "x8 · saved / frame pointer" },
  { label: "fp", detail: "x8 · frame pointer" },
  { label: "s1", detail: "x9 · saved" },
  { label: "a0", detail: "x10 · arg / return" },
  { label: "a1", detail: "x11 · arg / return" },
  { label: "a2", detail: "x12 · arg" },
  { label: "a3", detail: "x13 · arg" },
  { label: "a4", detail: "x14 · arg" },
  { label: "a5", detail: "x15 · arg" },
  { label: "a6", detail: "x16 · arg" },
  { label: "a7", detail: "x17 · arg / syscall" },
  { label: "s2", detail: "x18 · saved" },
  { label: "s3", detail: "x19 · saved" },
  { label: "s4", detail: "x20 · saved" },
  { label: "s5", detail: "x21 · saved" },
  { label: "s6", detail: "x22 · saved" },
  { label: "s7", detail: "x23 · saved" },
  { label: "s8", detail: "x24 · saved" },
  { label: "s9", detail: "x25 · saved" },
  { label: "s10", detail: "x26 · saved" },
  { label: "s11", detail: "x27 · saved" },
  { label: "t3", detail: "x28 · temp" },
  { label: "t4", detail: "x29 · temp" },
  { label: "t5", detail: "x30 · temp" },
  { label: "t6", detail: "x31 · temp" },
];

const REGISTER_DETAILS: Array<{ label: string; detail: string }> = [
  ...REGISTER_ALIASES,
  ...Array.from({ length: 32 }, (_, index) => {
    const alias = REGISTER_ALIASES.find((entry) => entry.detail.startsWith(`x${index} ·`));
    const suffix = alias?.detail.replace(/^x\d+\s·\s/, "");
    return {
      label: `x${index}`,
      detail: suffix ? `x${index} · ${suffix}` : `x${index}`,
    };
  }),
];

const MNEMONICS = new Set(MNEMONIC_DETAILS.map((entry) => entry.label));
const REGISTERS = new Set(REGISTER_DETAILS.map((entry) => entry.label));
const TOKEN_PATTERN = /(?:-?0x[0-9a-fA-F]+|-?\d+|\bx(?:[0-9]|[12][0-9]|3[01])\b|\b(?:zero|ra|sp|gp|tp|t[0-6]|s(?:[0-9]|1[01])|a[0-7]|fp)\b|\b[A-Za-z_.$][\w.$]*\b)/g;

function getLineHeight(textarea: HTMLTextAreaElement): number {
  const computed = window.getComputedStyle(textarea);
  const raw = Number.parseFloat(computed.lineHeight);
  if (Number.isFinite(raw)) {
    return raw;
  }
  return Number.parseFloat(computed.fontSize || "12") * 1.6;
}

function getPaddingTop(textarea: HTMLTextAreaElement): number {
  return Number.parseFloat(window.getComputedStyle(textarea).paddingTop || "12");
}

function getPaddingLeft(textarea: HTMLTextAreaElement): number {
  return Number.parseFloat(window.getComputedStyle(textarea).paddingLeft || "10");
}

function isInsideString(text: string): boolean {
  let inString = false;
  let escaped = false;

  for (const char of text) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
    }
  }

  return inString;
}

function commentIndex(text: string): number {
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (!inString && char === "#") {
      return index;
    }
  }
  return -1;
}

function currentLineInfo(textarea: HTMLTextAreaElement): { lineNumber: number; lineText: string; lineStart: number; column: number } {
  const value = textarea.value;
  const cursor = textarea.selectionStart;
  const beforeCursor = value.slice(0, cursor);
  const lastBreak = beforeCursor.lastIndexOf("\n");
  const nextBreak = value.indexOf("\n", cursor);
  const lineStart = lastBreak === -1 ? 0 : lastBreak + 1;
  const lineEnd = nextBreak === -1 ? value.length : nextBreak;
  return {
    lineNumber: beforeCursor.split("\n").length,
    lineText: value.slice(lineStart, lineEnd),
    lineStart,
    column: cursor - lineStart,
  };
}

function getCaretToken(lineText: string, column: number): { token: string; start: number; end: number } | null {
  const lineCommentIndex = commentIndex(lineText);
  if (lineCommentIndex >= 0 && column > lineCommentIndex) {
    return null;
  }
  if (isInsideString(lineText.slice(0, column))) {
    return null;
  }
  const local = lineText.slice(0, column);
  const fragment = /([A-Za-z_.$][\w.$]*|x(?:[0-9]|[12][0-9]|3[01])?)$/.exec(local);
  if (!fragment) {
    return null;
  }
  const token = fragment[1];
  return {
    token,
    start: column - token.length,
    end: column,
  };
}

function getMemoryParenRange(lineText: string, column: number): { open: number; close: number } | null {
  const pattern = /-?(?:0x[0-9a-fA-F]+|\d+)\(([^)]+)\)/g;
  for (const match of lineText.matchAll(pattern)) {
    const start = match.index ?? 0;
    const text = match[0];
    const open = start + text.indexOf("(");
    const close = start + text.lastIndexOf(")");
    if (column >= open && column <= close + 1) {
      return { open, close };
    }
  }
  return null;
}

function collectLabels(source: string): Set<string> {
  const labels = new Set<string>();
  for (const line of source.split("\n")) {
    const match = /^\s*([A-Za-z_.$][\w.$]*):/.exec(line);
    if (match) {
      labels.add(match[1]);
    }
  }
  return labels;
}

function findAnnotatedRange(lineText: string, diagnostic?: EditorDiagnostic): { start: number; end: number } | null {
  if (!diagnostic) {
    return null;
  }
  if (typeof diagnostic.col === "number" && diagnostic.col > 0) {
    const start = diagnostic.col - 1;
    const slice = lineText.slice(start);
    const token = /^([A-Za-z_.$][\w.$]*|x(?:[0-9]|[12][0-9]|3[01])|-?0x[0-9a-fA-F]+|-?\d+)/.exec(slice)?.[1] ?? "";
    return { start, end: start + Math.max(token.length, 1) };
  }
  const token = /^\s*(\S+)/.exec(lineText)?.[1];
  if (!token) {
    return null;
  }
  const start = lineText.indexOf(token);
  return { start, end: start + token.length };
}

function classifyToken(token: string, labels: ReadonlySet<string>): string {
  const lower = token.toLowerCase();
  if (REGISTERS.has(lower)) {
    return "asm-register";
  }
  if (/^-?(?:0x[0-9a-fA-F]+|\d+)$/.test(token)) {
    return "asm-immediate";
  }
  if (labels.has(token)) {
    return "asm-label-ref";
  }
  if (MNEMONICS.has(lower)) {
    return "asm-mnemonic";
  }
  return "";
}

function escapeWithParenHighlights(text: string, offset: number, parenRange: { open: number; close: number } | null): string {
  if (!text) {
    return "";
  }
  let html = "";
  for (let index = 0; index < text.length; index += 1) {
    const absoluteIndex = offset + index;
    const char = text[index];
    if (parenRange && (absoluteIndex === parenRange.open || absoluteIndex === parenRange.close)) {
      html += `<span class="asm-paren-match">${escapeHtml(char)}</span>`;
    } else {
      html += escapeHtml(char);
    }
  }
  return html;
}

function highlightLine(
  lineText: string,
  labels: ReadonlySet<string>,
  parenRange: { open: number; close: number } | null,
  activeLabel: string | null,
  annotation?: EditorDiagnostic
): string {
  const annotationRange = findAnnotatedRange(lineText, annotation);
  const commentStart = commentIndex(lineText);
  const codePart = commentStart >= 0 ? lineText.slice(0, commentStart) : lineText;
  const commentPart = commentStart >= 0 ? lineText.slice(commentStart) : "";

  let html = "";
  let cursor = 0;

  TOKEN_PATTERN.lastIndex = 0;
  for (const match of codePart.matchAll(TOKEN_PATTERN)) {
    const start = match.index ?? 0;
    const token = match[0];
    const end = start + token.length;
    html += escapeWithParenHighlights(codePart.slice(cursor, start), cursor, parenRange);

    const classes = new Set<string>();
    const tokenClass = classifyToken(token, labels);
    if (tokenClass) {
      classes.add(tokenClass);
    }
    if (activeLabel && token === activeLabel) {
      classes.add("asm-label-match");
    }
    if (annotationRange && start < annotationRange.end && end > annotationRange.start) {
      classes.add(annotation?.severity === "error" ? "asm-token-error" : "asm-token-warning");
    }

    const labelDefinitionMatch = /^\s*([A-Za-z_.$][\w.$]*):/.exec(codePart);
    if (labelDefinitionMatch && start === labelDefinitionMatch[0].indexOf(labelDefinitionMatch[1])) {
      classes.add("asm-label");
    }

    const classAttr = classes.size > 0 ? ` class="${Array.from(classes).join(" ")}"` : "";
    html += `<span${classAttr}>${escapeHtml(token)}</span>`;
    cursor = end;
  }

  html += escapeWithParenHighlights(codePart.slice(cursor), cursor, parenRange);

  if (commentPart) {
    html += `<span class="asm-comment">${escapeHtml(commentPart)}</span>`;
  }

  return html || "&nbsp;";
}

export function createEditor(config: EditorConfig) {
  const { container, textarea, lineNumbers, highlightDisplay, onGutterClick } = config;
  const editorInner = highlightDisplay.parentElement as HTMLElement;
  const annotationsLayer = document.createElement("div");
  annotationsLayer.className = "editor-annotations";
  editorInner.appendChild(annotationsLayer);

  const autocompleteEl = document.createElement("div");
  autocompleteEl.className = "editor-autocomplete";
  autocompleteEl.hidden = true;
  editorInner.appendChild(autocompleteEl);

  const measureEl = document.createElement("span");
  measureEl.className = "editor-char-measure";
  measureEl.textContent = "M";
  editorInner.appendChild(measureEl);

  let diagnostics: EditorDiagnostic[] = [];
  let breakpoints: Breakpoint[] = [];
  let activeItems: CompletionItem[] = [];
  let selectedIndex = 0;
  let labels = new Set<string>();
  let autocompleteRange: { start: number; end: number } | null = null;
  let lastHoveredLine: number | null = null;
  let refreshTimer: number | null = null;

  function currentLineNumber(): number {
    return textarea.value.substring(0, textarea.selectionStart).split("\n").length;
  }

  function syncScroll(): void {
    highlightDisplay.scrollTop = textarea.scrollTop;
    highlightDisplay.scrollLeft = textarea.scrollLeft;
    lineNumbers.scrollTop = textarea.scrollTop;
    annotationsLayer.scrollTop = textarea.scrollTop;
  }

  function renderLineNumbers(): void {
    const current = currentLineNumber();
    const lines = textarea.value.split("\n");
    const count = Math.max(10, lines.length);
    const diagnosticsByLine = new Map<number, EditorDiagnostic>();
    for (const diagnostic of diagnostics) {
      if (!diagnosticsByLine.has(diagnostic.line) || diagnostic.severity === "error") {
        diagnosticsByLine.set(diagnostic.line, diagnostic);
      }
    }

    lineNumbers.innerHTML = Array.from({ length: count }, (_, index) => {
      const line = index + 1;
      const breakpoint = breakpoints.find((candidate) => candidate.line === line);
      const diagnostic = diagnosticsByLine.get(line);
      const classes = ["editor-gutter-line"];
      if (line === current) {
        classes.push("current-line");
      }
      if (breakpoint) {
        classes.push("has-breakpoint");
        if (breakpoint.condition) {
          classes.push("has-conditional-breakpoint");
        }
      }
      if (diagnostic?.severity === "error") {
        classes.push("has-error");
      } else if (diagnostic) {
        classes.push("has-warning");
      }
      if (lastHoveredLine === line) {
        classes.push("is-hovered");
      }

      const label = line <= lines.length ? String(line) : "";
      return `<span class="${classes.join(" ")}" data-line="${line}">${
        breakpoint
          ? `<i class="editor-gutter-breakpoint"></i>${breakpoint.condition ? '<i class="editor-gutter-breakpoint-cond">cond</i>' : ""}`
          : escapeHtml(label)
      }</span>`;
    }).join("");
  }

  function renderHighlight(): void {
    labels = collectLabels(textarea.value);
    const lines = textarea.value.split("\n");
    const current = currentLineInfo(textarea);
    const tokenAtCursor = getCaretToken(current.lineText, current.column);
    const activeLabel = tokenAtCursor && labels.has(tokenAtCursor.token) ? tokenAtCursor.token : null;
    const diagnosticsByLine = new Map<number, EditorDiagnostic>();
    for (const diagnostic of diagnostics) {
      if (!diagnosticsByLine.has(diagnostic.line) || diagnostic.severity === "error") {
        diagnosticsByLine.set(diagnostic.line, diagnostic);
      }
    }

    highlightDisplay.innerHTML = lines
      .map((line, index) => {
        const lineNumber = index + 1;
        const classes = ["editor-highlight-line"];
        const diagnostic = diagnosticsByLine.get(lineNumber);
        if (diagnostic?.severity === "error") {
          classes.push("is-error-line");
        } else if (diagnostic) {
          classes.push("is-warning-line");
        }
        const parenRange = lineNumber === current.lineNumber ? getMemoryParenRange(current.lineText, current.column) : null;
        return `<div class="${classes.join(" ")}" data-line="${lineNumber}">${highlightLine(
          line,
          labels,
          parenRange,
          activeLabel,
          diagnostic
        )}</div>`;
      })
      .join("");
  }

  function renderDiagnostics(): void {
    const lineHeight = getLineHeight(textarea);
    const paddingTop = getPaddingTop(textarea);
    annotationsLayer.innerHTML = diagnostics
      .map((diagnostic) => {
        const top = paddingTop + (diagnostic.line - 1) * lineHeight;
        const tone = diagnostic.severity === "error" ? "error" : "warning";
        return `
          <div class="editor-diagnostic editor-diagnostic--${tone}" style="top:${top}px">
            <span class="editor-diagnostic__icon" title="${escapeHtml(diagnostic.message)}">⚠</span>
            <span class="editor-diagnostic__message">${escapeHtml(diagnostic.message)}</span>
          </div>
        `;
      })
      .join("");
  }

  function cursorPixelPosition(): { left: number; top: number } {
    const lineHeight = getLineHeight(textarea);
    const paddingTop = getPaddingTop(textarea);
    const paddingLeft = getPaddingLeft(textarea);
    const charWidth = Math.max(7, measureEl.getBoundingClientRect().width);
    const { lineNumber, column } = currentLineInfo(textarea);
    return {
      left: paddingLeft + column * charWidth - textarea.scrollLeft,
      top: paddingTop + (lineNumber - 1) * lineHeight - textarea.scrollTop,
    };
  }

  function hideAutocomplete(): void {
    autocompleteEl.hidden = true;
    autocompleteEl.innerHTML = "";
    activeItems = [];
    autocompleteRange = null;
    selectedIndex = 0;
  }

  function renderAutocomplete(): void {
    if (activeItems.length === 0 || !autocompleteRange) {
      hideAutocomplete();
      return;
    }
    const position = cursorPixelPosition();
    autocompleteEl.style.left = `${Math.max(8, position.left)}px`;
    autocompleteEl.style.top = `${Math.max(8, position.top + getLineHeight(textarea) + 6)}px`;
    autocompleteEl.innerHTML = activeItems
      .slice(0, 12)
      .map((item, index) => {
        const classes = ["editor-autocomplete__item"];
        if (index === selectedIndex) {
          classes.push("is-selected");
        }
        return `
          <button
            type="button"
            class="${classes.join(" ")}"
            data-index="${index}"
            title="${escapeHtml(item.hover ?? item.detail)}"
          >
            <span class="editor-autocomplete__label">${escapeHtml(item.label)}</span>
            <span class="editor-autocomplete__detail">${escapeHtml(item.detail)}</span>
          </button>
        `;
      })
      .join("");
    autocompleteEl.hidden = false;
  }

  function acceptCompletion(index = selectedIndex): void {
    if (!autocompleteRange) {
      return;
    }
    const item = activeItems[index];
    if (!item) {
      return;
    }
    textarea.setRangeText(item.label, autocompleteRange.start, autocompleteRange.end, "end");
    hideAutocomplete();
    sync();
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function updateAutocomplete(): void {
    const info = currentLineInfo(textarea);
    const lineCommentIndex = commentIndex(info.lineText);
    if (lineCommentIndex >= 0 && info.column > lineCommentIndex) {
      hideAutocomplete();
      return;
    }
    if (isInsideString(info.lineText.slice(0, info.column))) {
      hideAutocomplete();
      return;
    }

    const token = getCaretToken(info.lineText, info.column);
    if (!token || token.token.length < 2) {
      hideAutocomplete();
      return;
    }

    const beforeCursor = info.lineText.slice(0, token.start);
    const withoutLabel = beforeCursor.replace(/^\s*[A-Za-z_.$][\w.$]*:\s*/, "");
    const isMnemonicPosition = withoutLabel.trim().length === 0;
    const lower = token.token.toLowerCase();

    let matches: CompletionItem[] = [];
    if (isMnemonicPosition) {
      matches = MNEMONIC_DETAILS.filter((entry) => entry.label.startsWith(lower)).map((entry) => ({
        kind: "mnemonic",
        label: entry.label,
        detail: entry.detail,
        hover: entry.hover,
      }));
    } else {
      matches = REGISTER_DETAILS.filter((entry) => entry.label.startsWith(lower)).map((entry) => ({
        kind: "register",
        label: entry.label,
        detail: entry.detail,
      }));
    }

    if (matches.length === 0) {
      hideAutocomplete();
      return;
    }

    activeItems = matches.slice(0, 12);
    autocompleteRange = {
      start: info.lineStart + token.start,
      end: info.lineStart + token.end,
    };
    selectedIndex = Math.min(selectedIndex, activeItems.length - 1);
    renderAutocomplete();
  }

  function sync(): void {
    renderLineNumbers();
    renderHighlight();
    renderDiagnostics();
    syncScroll();
    updateAutocomplete();
  }

  function scheduleRefresh(): void {
    if (refreshTimer !== null) {
      window.clearTimeout(refreshTimer);
    }
    refreshTimer = window.setTimeout(() => {
      refreshTimer = null;
      sync();
    }, 50);
  }

  textarea.addEventListener("input", scheduleRefresh);
  textarea.addEventListener("scroll", syncScroll);
  textarea.addEventListener("click", scheduleRefresh);
  textarea.addEventListener("keyup", scheduleRefresh);
  textarea.addEventListener("focus", scheduleRefresh);
  textarea.addEventListener("keydown", (event) => {
    if (!autocompleteEl.hidden) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        selectedIndex = (selectedIndex + 1) % activeItems.length;
        renderAutocomplete();
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        selectedIndex = (selectedIndex - 1 + activeItems.length) % activeItems.length;
        renderAutocomplete();
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        acceptCompletion();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        hideAutocomplete();
        return;
      }
    }

    if (event.key === "Tab") {
      event.preventDefault();
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      textarea.setRangeText("  ", start, end, "end");
      scheduleRefresh();
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });

  lineNumbers.addEventListener("mousemove", (event) => {
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-line]");
    lastHoveredLine = target ? Number(target.dataset.line) : null;
    renderLineNumbers();
  });

  lineNumbers.addEventListener("mouseleave", () => {
    lastHoveredLine = null;
    renderLineNumbers();
  });

  lineNumbers.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-line]");
    if (!target) {
      return;
    }
    onGutterClick?.(Number(target.dataset.line));
  });

  autocompleteEl.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>("[data-index]");
    if (!target) {
      return;
    }
    acceptCompletion(Number(target.dataset.index));
  });

  document.addEventListener("click", (event) => {
    const target = event.target as Node | null;
    if (!target) {
      return;
    }
    if (!container.contains(target)) {
      hideAutocomplete();
    }
  });

  sync();

  return {
    sync,
    setDiagnostics(nextDiagnostics: EditorDiagnostic[]) {
      diagnostics = [...nextDiagnostics];
      sync();
    },
    clearDiagnostics() {
      diagnostics = [];
      sync();
    },
    setBreakpoints(nextBreakpoints: Breakpoint[]) {
      breakpoints = [...nextBreakpoints];
      renderLineNumbers();
    },
    hideAutocomplete,
    setReadOnly(readOnly: boolean) {
      textarea.disabled = readOnly;
      container.classList.toggle("is-readonly", readOnly);
    },
  };
}
