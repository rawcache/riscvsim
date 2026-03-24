import { describe, expect, it } from "vitest";

import {
  buildWeeklyChallenge,
  getCurrentWeekNumber,
  getMsUntilWeeklyReset,
  getWeeklyChallengeIndex,
} from "../../src/weekly-challenge";

describe("weekly-challenge", () => {
  it("Current week number computed correctly", () => {
    const now = Date.UTC(2026, 2, 23, 12, 0, 0);
    const expected = Math.floor(now / (7 * 24 * 60 * 60 * 1000));
    expect(getCurrentWeekNumber(now)).toBe(expected);
  });

  it("challengeId cycles through 0-19", () => {
    for (let index = 0; index < 40; index += 1) {
      const now = index * 7 * 24 * 60 * 60 * 1000;
      expect(getWeeklyChallengeIndex(now, 20)).toBe(index % 20);
    }
  });

  it("Countdown timer returns positive ms until Monday", () => {
    const thursday = Date.UTC(2026, 2, 26, 18, 0, 0);
    expect(getMsUntilWeeklyReset(thursday)).toBeGreaterThan(0);
  });

  it("WeeklyChallenge interface fields all present", () => {
    const weekly = buildWeeklyChallenge({
      challengeId: "challenge-1-sum-of-three",
      totalAttempts: 12,
      totalPassed: 8,
      topScorers: [{ displayName: "sseth", score: 100, timeSeconds: 44 }],
    });

    expect(weekly.challengeId).toBe("challenge-1-sum-of-three");
    expect(typeof weekly.weekNumber).toBe("number");
    expect(typeof weekly.startDate).toBe("string");
    expect(typeof weekly.endDate).toBe("string");
    expect(weekly.totalAttempts).toBe(12);
    expect(weekly.totalPassed).toBe(8);
    expect(weekly.topScorers[0]?.displayName).toBe("sseth");
  });
});
