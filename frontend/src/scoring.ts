import type { ChallengeSubmission } from "./challenges";
import type { UserProgress } from "./lessons";

const SCORE_STORAGE_KEY = "studyriscv_score";
const DEFAULT_API_ENDPOINT = "https://api.studyriscv.com";
const API_ENDPOINT = (import.meta.env.VITE_API_ENDPOINT as string | undefined)?.trim() || DEFAULT_API_ENDPOINT;

export interface UserScore {
  totalPoints: number;
  lessonPoints: number;
  challengePoints: number;
  lessonsCompleted: number;
  challengesPassed: number;
  streak: number;
  lastActiveDate: string;
  badges: Badge[];
}

export interface Badge {
  id: string;
  name: string;
  description: string;
  icon: string;
  earnedAt: string;
}

type BadgeDefinition = {
  id: string;
  name: string;
  description: string;
  icon: string;
};

const BADGE_DEFINITIONS: Record<string, BadgeDefinition> = {
  "first-step": {
    id: "first-step",
    name: "First Step",
    description: "Completed your first lesson step.",
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M5 12h10"></path><path d="m11 6 6 6-6 6"></path></svg>',
  },
  assembler: {
    id: "assembler",
    name: "Assembler",
    description: "Completed Lesson 1.",
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><rect x="4" y="5" width="16" height="14" rx="2"></rect><path d="M8 9h8M8 13h5"></path></svg>',
  },
  "memory-master": {
    id: "memory-master",
    name: "Memory Master",
    description: "Completed Lesson 2.",
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M6 7h12v10H6z"></path><path d="M9 7V4M15 7V4M9 20v-3M15 20v-3"></path></svg>',
  },
  "branch-prophet": {
    id: "branch-prophet",
    name: "Branch Prophet",
    description: "Completed Lesson 3.",
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M6 6h6v6"></path><path d="M12 6 5 13"></path><path d="M18 18H8"></path></svg>',
  },
  "stack-wizard": {
    id: "stack-wizard",
    name: "Stack Wizard",
    description: "Completed Lesson 4.",
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><rect x="5" y="6" width="14" height="3" rx="1"></rect><rect x="5" y="11" width="14" height="3" rx="1"></rect><rect x="5" y="16" width="14" height="3" rx="1"></rect></svg>',
  },
  sorter: {
    id: "sorter",
    name: "Sorter",
    description: "Completed Lesson 5.",
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M7 6h10M7 12h7M7 18h4"></path><path d="m15 10 2 2 4-4"></path></svg>',
  },
  "bit-twiddler": {
    id: "bit-twiddler",
    name: "Bit Twiddler",
    description: "Completed Lesson 6.",
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="8" cy="8" r="2"></circle><circle cx="16" cy="16" r="2"></circle><path d="M10 8h8M6 16h8"></path></svg>',
  },
  "speed-runner": {
    id: "speed-runner",
    name: "Speed Runner",
    description: "Completed a lesson in under 10 minutes.",
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="12" cy="13" r="7"></circle><path d="M12 13 16 9M9 3h6"></path></svg>',
  },
  "perfect-score": {
    id: "perfect-score",
    name: "Perfect Score",
    description: "Earned 100% on a challenge.",
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="m12 3 2.4 4.9 5.4.8-3.9 3.8.9 5.4L12 15.9 7.2 18l.9-5.4L4.2 8.7l5.4-.8L12 3Z"></path></svg>',
  },
  comeback: {
    id: "comeback",
    name: "Comeback",
    description: "Passed a challenge after failing at least three times.",
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M7 7H3v4"></path><path d="M3 11a9 9 0 1 0 2.6-6.4L3 7"></path></svg>',
  },
  "half-way": {
    id: "half-way",
    name: "Half Way",
    description: "Completed 8 lessons.",
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M4 20V8l8-4 8 4v12"></path><path d="M12 4v16"></path></svg>',
  },
  graduate: {
    id: "graduate",
    name: "Graduate",
    description: "Completed all 15 lessons.",
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="m3 10 9-5 9 5-9 5-9-5Z"></path><path d="M7 12.5V16c0 1.6 2.2 3 5 3s5-1.4 5-3v-3.5"></path></svg>',
  },
  champion: {
    id: "champion",
    name: "Champion",
    description: "Passed all 15 challenges.",
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M8 5h8v4a4 4 0 0 1-8 0V5Z"></path><path d="M6 7H4a2 2 0 0 0 2 2"></path><path d="M18 7h2a2 2 0 0 1-2 2"></path><path d="M12 13v4"></path><path d="M9 21h6"></path></svg>',
  },
};

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function emptyScore(): UserScore {
  return {
    totalPoints: 0,
    lessonPoints: 0,
    challengePoints: 0,
    lessonsCompleted: 0,
    challengesPassed: 0,
    streak: 0,
    lastActiveDate: "",
    badges: [],
  };
}

function normalizeScore(input: unknown): UserScore {
  if (!input || typeof input !== "object") {
    return emptyScore();
  }

  const raw = input as Partial<UserScore>;
  return {
    totalPoints: Number.isFinite(raw.totalPoints) ? Math.max(0, Number(raw.totalPoints)) : 0,
    lessonPoints: Number.isFinite(raw.lessonPoints) ? Math.max(0, Number(raw.lessonPoints)) : 0,
    challengePoints: Number.isFinite(raw.challengePoints) ? Math.max(0, Number(raw.challengePoints)) : 0,
    lessonsCompleted: Number.isFinite(raw.lessonsCompleted) ? Math.max(0, Number(raw.lessonsCompleted)) : 0,
    challengesPassed: Number.isFinite(raw.challengesPassed) ? Math.max(0, Number(raw.challengesPassed)) : 0,
    streak: Number.isFinite(raw.streak) ? Math.max(0, Number(raw.streak)) : 0,
    lastActiveDate: typeof raw.lastActiveDate === "string" ? raw.lastActiveDate : "",
    badges: Array.isArray(raw.badges)
      ? raw.badges.filter((badge): badge is Badge => Boolean(badge && typeof badge === "object" && "id" in badge))
      : [],
  };
}

function parseDateStamp(stamp: string): number | null {
  if (!stamp) {
    return null;
  }
  const parsed = Date.parse(`${stamp}T00:00:00.000Z`);
  return Number.isNaN(parsed) ? null : parsed;
}

function badgeAlreadyEarned(score: UserScore, badgeId: string): boolean {
  return score.badges.some((badge) => badge.id === badgeId);
}

function addBadge(score: UserScore, badgeId: string, earnedAt = new Date().toISOString()): Badge | null {
  if (badgeAlreadyEarned(score, badgeId)) {
    return null;
  }
  const definition = BADGE_DEFINITIONS[badgeId];
  if (!definition) {
    return null;
  }
  const badge: Badge = { ...definition, earnedAt };
  score.badges = [...score.badges, badge];
  return badge;
}

export function loadScore(): UserScore {
  if (typeof localStorage === "undefined") {
    return emptyScore();
  }

  const stored = localStorage.getItem(SCORE_STORAGE_KEY);
  if (!stored) {
    return emptyScore();
  }

  try {
    return normalizeScore(JSON.parse(stored) as unknown);
  } catch {
    return emptyScore();
  }
}

export function saveScore(score: UserScore): void {
  if (typeof localStorage === "undefined") {
    return;
  }
  localStorage.setItem(SCORE_STORAGE_KEY, JSON.stringify(normalizeScore(score)));
}

export function getScore(): UserScore {
  return loadScore();
}

export function addPoints(amount: number, reason: string): void {
  const score = loadScore();
  const today = todayIsoDate();
  const lastStamp = parseDateStamp(score.lastActiveDate);
  const todayStamp = parseDateStamp(today);
  let total = Math.max(0, amount);

  if (todayStamp !== null && lastStamp !== null) {
    const diffDays = Math.round((todayStamp - lastStamp) / 86_400_000);
    if (diffDays === 1) {
      score.streak += 1;
      total += 10;
    } else if (diffDays > 1) {
      score.streak = 1;
    }
  } else {
    score.streak = score.streak > 0 ? score.streak : 1;
  }

  score.totalPoints += total;
  if (reason.toLowerCase().includes("challenge")) {
    score.challengePoints += total;
  } else {
    score.lessonPoints += total;
  }
  score.lastActiveDate = today;
  saveScore(score);
}

export function checkAndAwardBadges(progress: UserProgress, submissions: ChallengeSubmission[]): Badge[] {
  const score = loadScore();
  const earnedAt = new Date().toISOString();
  const awarded: Badge[] = [];

  const completedLessons = Object.values(progress.lessons).filter((lesson) => lesson.completed);
  const passedChallengeIds = new Set(submissions.filter((submission) => submission.passed).map((submission) => submission.challengeId));

  const badgeChecks: Array<[string, boolean]> = [
    ["first-step", Object.values(progress.lessons).some((lesson) => lesson.stepsCompleted.length > 0)],
    ["assembler", progress.lessons["lesson-1-registers"]?.completed === true],
    ["memory-master", progress.lessons["lesson-2-memory"]?.completed === true],
    ["branch-prophet", progress.lessons["lesson-3-branches"]?.completed === true],
    ["stack-wizard", progress.lessons["lesson-4-functions"]?.completed === true],
    ["sorter", progress.lessons["lesson-5-sorting"]?.completed === true],
    ["bit-twiddler", progress.lessons["lesson-6-bitwise"]?.completed === true],
    [
      "speed-runner",
      completedLessons.some((lesson) => {
        if (!lesson.completedAt || !lesson.startedAt) {
          return false;
        }
        return Date.parse(lesson.completedAt) - Date.parse(lesson.startedAt) <= 10 * 60 * 1000;
      }),
    ],
    ["perfect-score", submissions.some((submission) => submission.passed && submission.score === submission.maxScore)],
    [
      "comeback",
      Array.from(passedChallengeIds).some((challengeId) => {
        const priorFailures = submissions.filter((submission) => submission.challengeId === challengeId && !submission.passed).length;
        return priorFailures >= 3;
      }),
    ],
    ["half-way", completedLessons.length >= 8],
    ["graduate", completedLessons.length >= 15],
    ["champion", passedChallengeIds.size >= 15],
  ];

  for (const [badgeId, condition] of badgeChecks) {
    if (!condition) {
      continue;
    }
    const badge = addBadge(score, badgeId, earnedAt);
    if (badge) {
      awarded.push(badge);
    }
  }

  score.lessonsCompleted = completedLessons.length;
  score.challengesPassed = passedChallengeIds.size;
  saveScore(score);
  return awarded;
}

export async function syncScoreToApi(score: UserScore, idToken: string): Promise<void> {
  if (!idToken || !API_ENDPOINT) {
    return;
  }

  try {
    await fetch(`${API_ENDPOINT}/leaderboard/score`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify(score),
    });
  } catch {
    // Intentionally ignore sync failures.
  }
}
