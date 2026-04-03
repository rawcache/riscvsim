// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";

import {
  MONACO_THEME_NAME,
  RISCV_KEYWORDS,
  RISCV_REGISTERS,
  bindVerdictClose,
  clampPanelSplit,
  escapeHtml,
  formatHex,
  formatTimerValue,
  getCurrentProblem,
  getCurrentProblemId,
  renderVerdictBanner,
  spawnConfetti,
} from "../../src/problem-list";

describe("problem-view helpers", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    window.history.replaceState({}, "", "/problems/");
  });

  it("escapes angle brackets, ampersands, quotes, and apostrophes", () => {
    expect(escapeHtml(`<tag attr="x">&'`)).toBe("&lt;tag attr=&quot;x&quot;&gt;&amp;&#39;");
  });

  it("formats 30 as lowercase 32-bit hex", () => {
    expect(formatHex(30)).toBe("0x0000001e");
  });

  it("formats negative numbers as unsigned 32-bit hex", () => {
    expect(formatHex(-1)).toBe("0xffffffff");
  });

  it("returns null for getCurrentProblemId when the query string is empty", () => {
    expect(getCurrentProblemId("")).toBeNull();
  });

  it("returns null for getCurrentProblem when the problem id is unknown", () => {
    expect(getCurrentProblem("?id=p999")).toBeNull();
  });

  it("uses the Monaco theme name riscv-dark", () => {
    expect(MONACO_THEME_NAME).toBe("riscv-dark");
  });

  it("includes add in the RISC-V keyword set", () => {
    expect(RISCV_KEYWORDS).toContain("add");
  });

  it("includes x10 in the RISC-V register set", () => {
    expect(RISCV_REGISTERS).toContain("x10");
  });

  it("clamps the left panel split to a minimum of 280px", () => {
    expect(clampPanelSplit(120, 1200)).toBe(280);
  });

  it("clamps the left panel split to a maximum of 65 percent", () => {
    expect(clampPanelSplit(900, 1000)).toBe(650);
  });

  it("formats zero seconds as 00:00", () => {
    expect(formatTimerValue(0)).toBe("00:00");
  });

  it("formats 61 seconds as 01:01", () => {
    expect(formatTimerValue(61)).toBe("01:01");
  });

  it("formats 3661 seconds as 1:01:01", () => {
    expect(formatTimerValue(3661)).toBe("1:01:01");
  });

  it("spawns 24 confetti pieces", () => {
    const container = spawnConfetti(document.body);
    expect(container.querySelectorAll(".pv-confetti-piece")).toHaveLength(24);
  });

  it("shows the verdict banner for an Accepted summary", () => {
    const banner = document.createElement("div");
    banner.hidden = true;
    const content = document.createElement("div");

    renderVerdictBanner(banner, content, {
      verdict: "Accepted",
      passedCount: 3,
      totalCount: 3,
      results: [],
      totalSteps: 47,
      totalTimeMs: 9,
    });

    expect(banner.hidden).toBe(false);
    expect(banner.classList.contains("pv-verdict--accepted")).toBe(true);
    expect(content.textContent).toContain("Accepted");
  });

  it("hides the verdict banner when the close button is clicked", () => {
    const banner = document.createElement("div");
    const closeButton = document.createElement("button");
    banner.hidden = false;

    bindVerdictClose(closeButton, banner);
    closeButton.click();

    expect(banner.hidden).toBe(true);
  });
});
