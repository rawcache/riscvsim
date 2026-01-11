import type { DisasmLine } from "./types";

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function renderDisasm(
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
