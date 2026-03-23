import { describe, expect, it } from "vitest";

import {
  computeEffectiveAddress,
  formatBitField,
  getInstructionType,
  willBranchBeq,
  willBranchBlt,
} from "../../src/disasm";

describe("disasm tooltip helpers", () => {
  it("getInstructionType('addi') returns 'I-type'", () => {
    expect(getInstructionType("addi")).toBe("I-type");
  });

  it("getInstructionType('beq') returns 'B-type'", () => {
    expect(getInstructionType("beq")).toBe("B-type");
  });

  it("getInstructionType('sw') returns 'S-type'", () => {
    expect(getInstructionType("sw")).toBe("S-type");
  });

  it("computeEffectiveAddress(0x10000000, 8) returns 0x10000008", () => {
    expect(computeEffectiveAddress(0x10000000, 8)).toBe(0x10000008);
  });

  it("willBranchBeq(5, 5) returns true", () => {
    expect(willBranchBeq(5, 5)).toBe(true);
  });

  it("willBranchBeq(5, 6) returns false", () => {
    expect(willBranchBeq(5, 6)).toBe(false);
  });

  it("willBranchBlt(3, 5) returns true (signed)", () => {
    expect(willBranchBlt(3, 5)).toBe(true);
  });

  it("formatBitField('addi', 0x00A00513) returns correct fields", () => {
    expect(formatBitField("addi", 0x00a00513)).toEqual({
      imm: "000000001010",
      rs1: "00000",
      funct3: "000",
      rd: "01010",
      opcode: "0010011",
    });
  });
});
