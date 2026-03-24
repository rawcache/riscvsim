// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { generateShareCard } from "../../src/share-card";

describe("share-card", () => {
  it("generateShareCard returns HTMLElement", () => {
    const card = generateShareCard({
      variant: "lesson",
      title: "Lesson 4 Complete",
      subtitle: "Functions & Calling Convention",
      stats: [{ label: "Steps", value: "12" }],
      accentColor: "var(--accent)",
    });

    expect(card).toBeInstanceOf(HTMLElement);
  });

  it('Card contains brand text "StudyRISC-V"', () => {
    const card = generateShareCard({
      variant: "lesson",
      title: "Lesson 4 Complete",
      subtitle: "Functions & Calling Convention",
      stats: [{ label: "Steps", value: "12" }],
      accentColor: "var(--accent)",
    });

    expect(card.textContent).toContain("StudyRISC-V");
  });

  it("Lesson variant card shows lesson title", () => {
    const card = generateShareCard({
      variant: "lesson",
      title: "Functions & Calling Convention",
      subtitle: "Lesson 4 Complete",
      stats: [{ label: "Steps", value: "12" }],
      accentColor: "var(--accent)",
    });

    expect(card.querySelector(".share-card__title")?.textContent).toBe("Functions & Calling Convention");
  });

  it("Challenge variant shows score", () => {
    const card = generateShareCard({
      variant: "challenge",
      title: "Challenge Cleared",
      subtitle: "Linked Lists",
      stats: [{ label: "Score", value: "90 / 100" }],
      accentColor: "var(--success)",
    });

    expect(card.textContent).toContain("90 / 100");
  });

  it("Stats array items render correctly", () => {
    const card = generateShareCard({
      variant: "quiz",
      title: "Quiz Passed",
      subtitle: "Midterm Simulation",
      stats: [
        { label: "Score", value: "92%" },
        { label: "Time", value: "8m 14s" },
      ],
      accentColor: "var(--accent)",
    });

    expect(card.querySelectorAll(".share-card__stat")).toHaveLength(2);
    expect(card.textContent).toContain("92%");
    expect(card.textContent).toContain("8m 14s");
  });

  it("Streak shows fire emoji when streakDays > 0", () => {
    const card = generateShareCard({
      variant: "lesson",
      title: "Lesson Complete",
      subtitle: "Registers and Arithmetic",
      stats: [{ label: "Steps", value: "7" }],
      streakDays: 5,
      accentColor: "var(--accent)",
    });

    expect(card.querySelector(".share-card__streak")?.textContent).toContain("🔥");
  });
});
