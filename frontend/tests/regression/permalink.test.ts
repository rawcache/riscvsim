import { describe, expect, it } from "vitest";
import { decodeProgram, encodeProgram } from "../../src/permalink";

describe("permalink encoding", () => {
  it("round-trips a small assembly program", async () => {
    const source = ["addi x1, x0, 1", "addi x2, x1, 2", "ecall"].join("\n");

    const encoded = await encodeProgram(source);
    const decoded = await decodeProgram(encoded);

    expect(decoded).toBe(source);
  });

  it("returns null for a corrupt string", async () => {
    await expect(decodeProgram("*not-base64url*")).resolves.toBeNull();
  });

  it("round-trips a long program", async () => {
    const source = Array.from({ length: 80 }, (_, index) => {
      return `addi x${(index % 31) + 1}, x${index % 31}, ${index}`;
    }).join("\n");

    expect(source.length).toBeGreaterThan(500);

    const encoded = await encodeProgram(source);
    const decoded = await decodeProgram(encoded);

    expect(decoded).toBe(source);
  });

  it("emits only URL-safe characters", async () => {
    const encoded = await encodeProgram(".data\nmsg:\n  .asciz \"Hello, RISC-V!\"\n.text\nla a0, msg\necall");
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
