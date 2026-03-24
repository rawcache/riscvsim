import { describe, expect, it } from "vitest";

import {
  LESSON_COMPLETION_XP,
  LESSON_READING_CHECKPOINT_DOT_RADIUS,
  LESSON_READING_CURRENT_DOT_WIDTH,
  LESSON_READING_DEFAULT_DOT_WIDTH,
  renderStepContent,
} from "../../src/lesson-mode";

describe("lesson reading renderer", () => {
  it("renderStepContent wraps **bold** in <strong>", () => {
    expect(renderStepContent("Use **addi** here.")).toContain("<strong>addi</strong>");
  });

  it("renderStepContent wraps `code` in <code>", () => {
    expect(renderStepContent("Write `addi x1, x0, 10`.")).toContain("<code>addi x1, x0, 10</code>");
  });

  it("renderStepContent wraps [tip]...[/tip] in .lro-tip", () => {
    expect(renderStepContent("[tip]Helpful note[/tip]")).toContain('class="lro-tip"');
  });

  it("renderStepContent wraps [warning]...[/warning] in .lro-warning", () => {
    expect(renderStepContent("[warning]Careful[/warning]")).toContain('class="lro-tip lro-warning"');
  });

  it("renderStepContent wraps [concept]...[/concept] in .lro-concept", () => {
    expect(renderStepContent("[concept]Key idea[/concept]")).toContain('class="lro-concept"');
  });

  it("renderStepContent does not process content inside code blocks", () => {
    const html = renderStepContent("```addi x1, x0, 0x10```");
    expect(html).toContain("<pre>");
    expect(html).not.toContain("lro-reg-ref");
    expect(html).not.toContain("lro-addr-ref");
  });

  it("renderStepContent converts --- to <hr>", () => {
    expect(renderStepContent("---")).toContain("<hr");
  });

  it("renderStepContent converts blank lines to <p> breaks", () => {
    const html = renderStepContent("First paragraph.\n\nSecond paragraph.");
    expect(html).toContain("<p>First paragraph.</p>");
    expect(html).toContain("<p>Second paragraph.</p>");
  });

  it("renderStepContent wraps 0x hex addresses in .lro-addr-ref", () => {
    expect(renderStepContent("Jump to 0x10000000.")).toContain('class="lro-addr-ref">0x10000000</span>');
  });

  it("renderStepContent handles empty string input", () => {
    expect(renderStepContent("")).toBe("");
  });

  it("renderStepContent handles content with no markers", () => {
    expect(renderStepContent("Plain paragraph only.")).toContain("<p>Plain paragraph only.</p>");
  });

  it("Dot width is 20px for current step and 7px for others", () => {
    expect(LESSON_READING_CURRENT_DOT_WIDTH).toBe(20);
    expect(LESSON_READING_DEFAULT_DOT_WIDTH).toBe(7);
  });

  it("Checkpoint steps show square dots (border-radius 2px)", () => {
    expect(LESSON_READING_CHECKPOINT_DOT_RADIUS).toBe(2);
  });

  it("Completion card shows correct XP (+50)", () => {
    expect(LESSON_COMPLETION_XP).toBe(50);
  });
});
