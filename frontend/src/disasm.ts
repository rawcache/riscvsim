import { escapeHtml, hex32 } from "./format";
import type { DisasmLine } from "./types";

function splitInstruction(text: string): { mnemonic: string; operands: string } {
  const trimmed = text.trim();
  const firstSpace = trimmed.search(/\s/);
  if (firstSpace < 0) {
    return { mnemonic: trimmed, operands: "" };
  }
  return {
    mnemonic: trimmed.slice(0, firstSpace),
    operands: trimmed.slice(firstSpace).trim(),
  };
}

export function renderDisasm(
  pc: number | undefined,
  prevPc: number | undefined,
  disasm?: DisasmLine[],
  encodings: ReadonlyMap<number, string> = new Map<number, string>()
): string {
  if (!disasm || disasm.length === 0) {
    return `
      <div class="disasm-empty">
        <div class="disasm-line disasm-line--placeholder">
          <span class="disasm-addr">0x00000000</span>
          <span class="disasm-encoding">00000013</span>
          <span class="disasm-mnemonic">addi</span>
          <span class="disasm-operands">x0, x0, 0</span>
        </div>
        <div class="disasm-line disasm-line--placeholder">
          <span class="disasm-addr">0x00000004</span>
          <span class="disasm-encoding">...</span>
          <span class="disasm-mnemonic">...</span>
          <span class="disasm-operands">...</span>
        </div>
        <div class="empty-state empty-state--note"><em>Disassembly will appear after assembly.</em></div>
      </div>
    `;
  }

  return disasm
    .map((line) => {
      const classes = ["disasm-line"];
      if (line.label) {
        classes.push("label", "disasm-line--label");
        return `
          <div class="${classes.join(" ")}">
            <span class="disasm-label">${escapeHtml(line.text)}</span>
          </div>
        `;
      }

      if (pc !== undefined && line.pc === pc) {
        classes.push("current", "disasm-pc-current");
      } else if (prevPc !== undefined && line.pc === prevPc) {
        classes.push("prev", "disasm-pc-prev");
      }

      const { mnemonic, operands } = splitInstruction(line.text);
      return `
        <div class="${classes.join(" ")}" data-pc="${line.pc >>> 0}">
          <span class="disasm-addr">${hex32(line.pc)}</span>
          <span class="disasm-encoding">${escapeHtml(encodings.get(line.pc) ?? "--------")}</span>
          <span class="disasm-mnemonic">${escapeHtml(mnemonic)}</span>
          <span class="disasm-operands">${escapeHtml(operands)}</span>
        </div>
      `;
    })
    .join("");
}
