import { getChallenges } from "./challenges";

export interface WeeklyChallenge {
  challengeId: string;
  weekNumber: number;
  startDate: string;
  endDate: string;
  totalAttempts: number;
  totalPassed: number;
  topScorers: Array<{
    displayName: string;
    score: number;
    timeSeconds: number;
  }>;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function getCurrentWeekNumber(now = Date.now()): number {
  return Math.floor(now / WEEK_MS);
}

export function getWeeklyChallengeIndex(now = Date.now(), totalChallenges = getChallenges().length): number {
  const count = Math.max(1, totalChallenges);
  return getCurrentWeekNumber(now) % count;
}

export function getWeeklyChallengeId(now = Date.now()): string {
  const challenges = getChallenges();
  return challenges[getWeeklyChallengeIndex(now, challenges.length)]?.id ?? challenges[0]?.id ?? "";
}

function nextMondayUtcDate(now = Date.now()): Date {
  const current = new Date(now);
  const day = current.getUTCDay();
  const daysUntilMonday = day === 1 ? 7 : ((8 - day) % 7) || 7;
  return new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate() + daysUntilMonday));
}

export function getMsUntilWeeklyReset(now = Date.now()): number {
  return Math.max(0, nextMondayUtcDate(now).getTime() - now);
}

export function formatWeeklyCountdown(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  return `${days}d ${hours}h ${minutes}m`;
}

export function buildWeeklyChallenge(overrides: Partial<WeeklyChallenge> = {}): WeeklyChallenge {
  const now = Date.now();
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  const end = nextMondayUtcDate(now);
  return {
    challengeId: getWeeklyChallengeId(now),
    weekNumber: getCurrentWeekNumber(now),
    startDate: start.toISOString(),
    endDate: end.toISOString(),
    totalAttempts: 0,
    totalPassed: 0,
    topScorers: [],
    ...overrides,
  };
}
