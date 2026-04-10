type OpcodeMeta = {
  key: string;
  description: string;
  example: string;
  detailTitle: string;
  detailBody: string;
  detailFlow: string;
};

const OPCODES: OpcodeMeta[] = [
  {
    key: "ADDI",
    description: "Add an immediate constant to a register.",
    example: "addi x5, x0, 10",
    detailTitle: "Immediate setup for constants and loop counters",
    detailBody:
      "Use addi for quick register updates without touching memory. It shows up everywhere: loop indexes, stack pointer movement, and small constant setup.",
    detailFlow: "x5 ← x0 + 10",
  },
  {
    key: "LW",
    description: "Load a 32-bit word from memory into a register.",
    example: "lw x8, 0(x2)",
    detailTitle: "Bridge between an address and a usable register value",
    detailBody:
      "lw makes the memory hierarchy visible. The base register supplies the address, the offset selects the slot, and the loaded value becomes data the ALU can actually use.",
    detailFlow: "x8 ← Mem[x2 + 0]",
  },
  {
    key: "SW",
    description: "Store a 32-bit word from a register into memory.",
    example: "sw x8, 12(x2)",
    detailTitle: "Commit register state back into memory",
    detailBody:
      "sw is how stack frames, arrays, and saved registers become concrete. It writes the register value into an addressable location that later instructions can load again.",
    detailFlow: "Mem[x2 + 12] ← x8",
  },
  {
    key: "ADD",
    description: "Add two registers and write the result.",
    example: "add x10, x11, x12",
    detailTitle: "Classic ALU combination of two live register values",
    detailBody:
      "add is the cleanest view of the datapath: read register A, read register B, compute, then write a new value into the destination register on the next stage.",
    detailFlow: "x10 ← x11 + x12",
  },
  {
    key: "MUL",
    description: "Multiply two registers using the M extension.",
    example: "mul x6, x7, x8",
    detailTitle: "A heavier arithmetic operation moving through the same pipeline",
    detailBody:
      "mul shows that even more expensive math still follows the same machine model. Source registers feed the execute stage, and the product comes back as a regular register writeback.",
    detailFlow: "x6 ← x7 × x8",
  },
  {
    key: "BEQ",
    description: "Branch when two registers are equal.",
    example: "beq x5, x0, done",
    detailTitle: "Control flow changes only if the comparison resolves true",
    detailBody:
      "beq is where branch prediction matters. The CPU compares two live register values and either keeps sequential flow or redirects the program counter to a new target.",
    detailFlow: "if x5 = x0 → pc ← done",
  },
  {
    key: "BNE",
    description: "Branch when two registers are not equal.",
    example: "bne x3, x4, loop",
    detailTitle: "The loop primitive that keeps execution moving",
    detailBody:
      "bne is the instruction behind most countdown loops. It turns a comparison result into control flow, making the program counter itself part of the visible machine state.",
    detailFlow: "if x3 ≠ x4 → pc ← loop",
  },
  {
    key: "JAL",
    description: "Jump and link to a target while saving the return address.",
    example: "jal x1, func",
    detailTitle: "Call flow as a program-counter update plus saved return point",
    detailBody:
      "jal is what makes function calls feel real. It stores the next instruction into a register and moves control to a new location, setting up a later return.",
    detailFlow: "x1 ← pc + 4, pc ← func",
  },
  {
    key: "JALR",
    description: "Jump through a computed register target and link.",
    example: "jalr x0, 0(x1)",
    detailTitle: "Return or indirect jump through a computed address",
    detailBody:
      "jalr is how returns and indirect control flow happen. The machine forms a target address from a register plus offset, clears the low bit, and transfers control there.",
    detailFlow: "pc ← (x1 + 0) & ~1",
  },
  {
    key: "ANDI",
    description: "Mask a register with an immediate value.",
    example: "andi x9, x9, 255",
    detailTitle: "Bit-level cleanup using a constant mask",
    detailBody:
      "andi is useful when you want to keep only certain bits. It turns immediate constants into a visible filter over an existing register value.",
    detailFlow: "x9 ← x9 & 255",
  },
  {
    key: "SLLI",
    description: "Shift a register left by an immediate amount.",
    example: "slli x6, x6, 2",
    detailTitle: "Cheap scaling for addresses and powers of two",
    detailBody:
      "slli is the machine-level way to multiply by powers of two. It is common in indexing math, especially when converting an element index into a byte offset.",
    detailFlow: "x6 ← x6 << 2",
  },
  {
    key: "LUI",
    description: "Load an upper immediate into a register.",
    example: "lui x3, 0x10000",
    detailTitle: "Construct large constants and addresses in two steps",
    detailBody:
      "lui gives you the high bits first, which is why it often appears next to addi. Together they build full addresses and large constants that do not fit in a small immediate field.",
    detailFlow: "x3 ← 0x10000 << 12",
  },
];

function createChip(meta: OpcodeMeta): HTMLButtonElement {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "cov-chip";
  chip.dataset.opcodeKey = meta.key;
  chip.setAttribute("aria-label", `${meta.key}: ${meta.description}`);
  chip.textContent = meta.key;
  return chip;
}

export function initOpcodeBand(): void {
  const root = document.querySelector<HTMLElement>("[data-opcode-band]");
  if (!(root instanceof HTMLElement)) {
    return;
  }

  const track = root.querySelector<HTMLElement>("[data-opcode-track]");
  const name = root.querySelector<HTMLElement>("[data-opcode-name]");
  const description = root.querySelector<HTMLElement>("[data-opcode-description]");
  const example = root.querySelector<HTMLElement>("[data-opcode-example]");
  const detailTitle = root.querySelector<HTMLElement>("[data-opcode-detail-title]");
  const detailBody = root.querySelector<HTMLElement>("[data-opcode-detail-body]");
  const detailFlow = root.querySelector<HTMLElement>("[data-opcode-detail-flow]");

  if (!track || !name || !description || !example || !detailTitle || !detailBody || !detailFlow) {
    return;
  }

  if (root.dataset.opcodeMounted === "1") {
    return;
  }
  root.dataset.opcodeMounted = "1";

  const fragment = document.createDocumentFragment();
  for (let repeat = 0; repeat < 3; repeat += 1) {
    for (const meta of OPCODES) {
      fragment.appendChild(createChip(meta));
    }
  }
  track.appendChild(fragment);

  let activeIndex = 0;
  let hoverKey: string | null = null;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const applyActiveState = (meta: OpcodeMeta) => {
    name.textContent = meta.key;
    description.textContent = meta.description;
    example.textContent = meta.example;
    detailTitle.textContent = meta.detailTitle;
    detailBody.textContent = meta.detailBody;
    detailFlow.textContent = meta.detailFlow;

    track.querySelectorAll<HTMLElement>(".cov-chip").forEach((chip) => {
      chip.classList.toggle("is-active", chip.dataset.opcodeKey === meta.key);
    });
  };

  const syncFromKey = (key: string) => {
    const nextIndex = OPCODES.findIndex((opcode) => opcode.key === key);
    if (nextIndex === -1) {
      return;
    }
    activeIndex = nextIndex;
    applyActiveState(OPCODES[nextIndex]);
  };

  applyActiveState(OPCODES[activeIndex]);

  track.addEventListener("pointerover", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const chip = target.closest<HTMLElement>(".cov-chip");
    const key = chip?.dataset.opcodeKey;
    if (!key) {
      return;
    }
    hoverKey = key;
    syncFromKey(key);
  });

  root.addEventListener("pointerleave", () => {
    hoverKey = null;
    applyActiveState(OPCODES[activeIndex]);
  });

  track.addEventListener("focusin", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const chip = target.closest<HTMLElement>(".cov-chip");
    const key = chip?.dataset.opcodeKey;
    if (!key) {
      return;
    }
    hoverKey = key;
    syncFromKey(key);
  });

  track.addEventListener("focusout", () => {
    hoverKey = null;
    applyActiveState(OPCODES[activeIndex]);
  });

  if (!reducedMotion) {
    window.setInterval(() => {
      if (hoverKey !== null) {
        return;
      }
      activeIndex = (activeIndex + 1) % OPCODES.length;
      applyActiveState(OPCODES[activeIndex]);
    }, 2600);
  }
}
