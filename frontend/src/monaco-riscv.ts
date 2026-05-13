export interface MonacoEditorOptions {
  containerId: string;
  starterCode: string;
  problemId?: string;
  onReady?: (editor: any) => void;
  onError?: (err: any) => void;
}

declare global {
  interface Window {
    __editorInstance?: any;
    __editorFallback?: HTMLTextAreaElement | null;
    __studyriscvMonacoThemeObserver?: MutationObserver | null;
  }
}

const MONACO_CDN =
  "https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs";

const RISCV_MONARCH_TOKENS = {
  defaultToken: "",
  tokenPostfix: ".riscv",
  keywords: [
    "add", "sub", "sll", "slt", "sltu", "xor", "srl", "sra",
    "or", "and",
    "mul", "mulh", "mulhsu", "mulhu",
    "div", "divu", "rem", "remu",
    "addi", "slti", "sltiu", "xori", "ori", "andi",
    "slli", "srli", "srai",
    "lb", "lh", "lw", "lbu", "lhu",
    "sb", "sh", "sw",
    "beq", "bne", "blt", "bge", "bltu", "bgeu",
    "jalr", "jal", "lui", "auipc",
    "ecall", "ebreak", "fence",
    "li", "la", "mv", "nop", "ret", "call", "tail",
    "j", "jr", "not", "neg",
    "seqz", "snez", "sltz", "sgtz",
    "beqz", "bnez", "blez", "bgez", "bltz", "bgtz",
    "bgt", "ble", "bgtu", "bleu",
  ],
  registers: [
    "x0", "x1", "x2", "x3", "x4", "x5", "x6", "x7",
    "x8", "x9", "x10", "x11", "x12", "x13", "x14", "x15",
    "x16", "x17", "x18", "x19", "x20", "x21", "x22", "x23",
    "x24", "x25", "x26", "x27", "x28", "x29", "x30", "x31",
    "zero", "ra", "sp", "gp", "tp", "fp", "pc",
    "a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7",
    "t0", "t1", "t2", "t3", "t4", "t5", "t6",
    "s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7",
    "s8", "s9", "s10", "s11",
  ],
  tokenizer: {
    root: [
      [/#.*$/, "comment"],
      [/[a-zA-Z_][a-zA-Z0-9_]*(?=\s*:)/, "type.identifier"],
      [/\.[a-zA-Z][a-zA-Z0-9_]*/, "keyword.directive"],
      [/0[xX][0-9a-fA-F]+/, "number.hex"],
      [/-?[0-9]+/, "number"],
      [/"([^"\\]|\\.)*"/, "string"],
      [/[ \t\r\n]+/, "white"],
      [
        /[a-zA-Z_][a-zA-Z0-9_]*/,
        {
          cases: {
            "@registers": "variable.register",
            "@keywords": "keyword",
            "@default": "identifier",
          },
        },
      ],
      [/[(),:]/, "delimiter"],
    ],
  },
} as const;

const DARK_THEME = {
  base: "vs-dark" as const,
  inherit: true,
  rules: [
    { token: "comment", foreground: "5a6a5a", fontStyle: "italic" },
    { token: "keyword", foreground: "4D87F5", fontStyle: "bold" },
    { token: "keyword.directive", foreground: "a78bfa" },
    { token: "variable.register", foreground: "22c55e" },
    { token: "type.identifier", foreground: "f59e0b" },
    { token: "number", foreground: "f87171" },
    { token: "number.hex", foreground: "fb923c" },
    { token: "string", foreground: "fde68a" },
    { token: "delimiter", foreground: "444444" },
  ],
  colors: {
    "editor.background": "#0a0a0a",
    "editor.foreground": "#e4e4e7",
    "editor.lineHighlightBackground": "#111111",
    "editor.lineHighlightBorder": "#00000000",
    "editorLineNumber.foreground": "#3a3a3a",
    "editorLineNumber.activeForeground": "#777777",
    "editor.selectionBackground": "#2D6BE440",
    "editorCursor.foreground": "#4D87F5",
    "editorGutter.background": "#0a0a0a",
  },
} as const;

const LIGHT_THEME = {
  base: "vs" as const,
  inherit: true,
  rules: [
    { token: "comment", foreground: "6b7280", fontStyle: "italic" },
    { token: "keyword", foreground: "2563eb", fontStyle: "bold" },
    { token: "keyword.directive", foreground: "7c3aed" },
    { token: "variable.register", foreground: "16a34a" },
    { token: "type.identifier", foreground: "d97706" },
    { token: "number", foreground: "dc2626" },
    { token: "number.hex", foreground: "ea580c" },
    { token: "string", foreground: "b45309" },
    { token: "delimiter", foreground: "9ca3af" },
  ],
  colors: {
    "editor.background": "#fafafa",
    "editor.foreground": "#111111",
    "editor.lineHighlightBackground": "#f3f4f6",
    "editorLineNumber.foreground": "#9ca3af",
    "editorLineNumber.activeForeground": "#374151",
    "editor.selectionBackground": "#2D6BE430",
    "editorCursor.foreground": "#2D6BE4",
  },
} as const;

let loaderPromise: Promise<void> | null = null;
let editorMainPromise: Promise<any> | null = null;

function ensureLoader(): Promise<void> {
  const w = window as any;
  if (w.require) {
    return Promise.resolve();
  }
  if (loaderPromise) {
    return loaderPromise;
  }

  loaderPromise = new Promise<void>((resolve, reject) => {
    const existingLoader = document.querySelector<HTMLScriptElement>(
      "script[data-monaco-loader='1'],script[src*='monaco-editor'][src*='loader.min.js']"
    );

    if (existingLoader) {
      if (w.require) {
        resolve();
        return;
      }
      existingLoader.addEventListener("load", () => resolve(), { once: true });
      existingLoader.addEventListener("error", () => reject(new Error("Failed to load Monaco AMD loader.")), {
        once: true,
      });
      return;
    }

    const script = document.createElement("script");
    script.src = `${MONACO_CDN}/loader.min.js`;
    script.async = true;
    script.dataset.monacoLoader = "1";
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener("error", () => reject(new Error("Failed to load Monaco AMD loader.")), {
      once: true,
    });
    document.head.appendChild(script);
  });

  return loaderPromise;
}

function ensureEditorMain(): Promise<any> {
  const w = window as any;
  if (w.monaco?.editor) {
    return Promise.resolve(w.monaco);
  }
  if (editorMainPromise) {
    return editorMainPromise;
  }

  editorMainPromise = ensureLoader().then(
    () =>
      new Promise<any>((resolve, reject) => {
        const requireJs = w.require;
        if (!requireJs) {
          reject(new Error("Monaco AMD loader was not available."));
          return;
        }

        requireJs.config({
          paths: {
            vs: MONACO_CDN,
          },
        });

        requireJs(
          ["vs/editor/editor.main"],
          () => resolve(w.monaco),
          (err: any) => reject(err)
        );
      })
  );

  return editorMainPromise;
}

function ensureRiscvLanguage(monaco: any): void {
  if (!monaco.languages.getLanguages().some((language: any) => language.id === "riscv")) {
    monaco.languages.register({ id: "riscv" });
    monaco.languages.setMonarchTokensProvider("riscv", RISCV_MONARCH_TOKENS);
  }
}

function ensureThemes(monaco: any): void {
  try {
    monaco.editor.defineTheme("studyriscv-dark", DARK_THEME);
  } catch {
    // Ignore duplicate theme registration.
  }
  try {
    monaco.editor.defineTheme("studyriscv-light", LIGHT_THEME);
  } catch {
    // Ignore duplicate theme registration.
  }
}

function syncTheme(monaco: any): void {
  const dark = document.documentElement.getAttribute("data-theme") !== "light";
  monaco.editor.setTheme(dark ? "studyriscv-dark" : "studyriscv-light");
}

function startThemeSync(monaco: any): void {
  syncTheme(monaco);
  if (window.__studyriscvMonacoThemeObserver) {
    return;
  }

  const observer = new MutationObserver(() => {
    syncTheme(monaco);
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "class"],
  });
  window.__studyriscvMonacoThemeObserver = observer;
  window.addEventListener(
    "beforeunload",
    () => {
      window.__studyriscvMonacoThemeObserver?.disconnect();
      window.__studyriscvMonacoThemeObserver = null;
    },
    { once: true }
  );
}

export function showFallbackTextarea(containerId: string, starterCode: string): void {
  const el = document.getElementById(containerId);
  if (!el) {
    return;
  }
  el.innerHTML = "";
  const ta = document.createElement("textarea");
  ta.value = starterCode;
  ta.spellcheck = false;
  ta.style.cssText = [
    "width:100%",
    "height:100%",
    "min-height:300px",
    "padding:16px",
    "background:#0a0a0a",
    "color:#e4e4e7",
    "font-family:'Geist Mono',monospace",
    "font-size:13px",
    "line-height:1.7",
    "border:none",
    "outline:none",
    "resize:none",
    "box-sizing:border-box",
  ].join(";");
  el.appendChild(ta);
  (window as any).__editorInstance = null;
  (window as any).__editorFallback = ta;
}

export function getEditorCode(): string {
  const w = window as any;
  if (w.__editorInstance) {
    return w.__editorInstance.getValue();
  }
  if (w.__editorFallback) {
    return (w.__editorFallback as HTMLTextAreaElement).value;
  }
  return "";
}

export function initRiscvEditor(options: MonacoEditorOptions): void {
  const el = document.getElementById(options.containerId);
  if (!el) {
    const error = new Error(`Monaco: container not found: ${options.containerId}`);
    console.error(error.message);
    showFallbackTextarea(options.containerId, options.starterCode);
    options.onError?.(error);
    return;
  }

  const rect = el.getBoundingClientRect();
  console.log("Monaco container dimensions:", rect.width, "x", rect.height);
  console.log("Monaco: configuring require...");
  console.log("Monaco: loading editor.main...");

  let settled = false;
  const timeoutId = setTimeout(() => {
    if (!settled) {
      settled = true;
      console.warn("Monaco: load timed out after 12s — falling back to textarea");
      showFallbackTextarea(options.containerId, options.starterCode);
      options.onError?.(new Error("Monaco load timeout"));
    }
  }, 12000);

  ensureEditorMain()
    .then((monaco) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      console.log("Monaco: editor.main loaded");

      ensureRiscvLanguage(monaco);
      ensureThemes(monaco);

      const isDark = document.documentElement.getAttribute("data-theme") !== "light";
      el.innerHTML = "";

      const editor = monaco.editor.create(el, {
        value: options.starterCode,
        language: "riscv",
        theme: isDark ? "studyriscv-dark" : "studyriscv-light",
        automaticLayout: true,
        fontFamily: "'Geist Mono','Fira Code',monospace",
        fontSize: 13,
        lineHeight: 22,
        tabSize: 2,
        insertSpaces: true,
        lineNumbers: "on",
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        renderLineHighlight: "all",
        cursorBlinking: "smooth",
        smoothScrolling: true,
        padding: { top: 16, bottom: 16 },
        glyphMargin: false,
        folding: false,
        wordWrap: "off",
        overviewRulerLanes: 0,
      });

      (window as any).__editorInstance = editor;
      (window as any).__editorFallback = null;

      if (options.problemId) {
        let t: ReturnType<typeof setTimeout>;
        editor.onDidChangeModelContent(() => {
          clearTimeout(t);
          t = setTimeout(() => {
            localStorage.setItem(`problems_code_${options.problemId}`, editor.getValue());
          }, 2000);
        });
        const saved = localStorage.getItem(`problems_code_${options.problemId}`);
        if (saved) {
          editor.setValue(saved);
        }
      }

      startThemeSync(monaco);
      options.onReady?.(editor);
    })
    .catch((err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      console.error("Monaco failed to load:", err);
      options.onError?.(err);
      showFallbackTextarea(options.containerId, options.starterCode);
    });
}
