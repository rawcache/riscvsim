import type { ChallengeSubmission } from "./challenges";
import type { UserProgress } from "./lessons";
import { getStoredReferral } from "./referrals";

const SCORE_STORAGE_KEY = "studyriscv_score";
const LEGACY_SCORE_STORAGE_KEY = "studyriscv_score";
const ID_TOKEN_KEY = "studyriscv_id_token";
const DEFAULT_API_ENDPOINT = "https://api.studyriscv.com";
const API_ENDPOINT = (import.meta.env.VITE_API_ENDPOINT as string | undefined)?.trim() || DEFAULT_API_ENDPOINT;
const MS_PER_DAY = 86_400_000;

export interface UserScore {
  totalPoints: number;
  lessonPoints: number;
  challengePoints: number;
  lessonsCompleted: number;
  challengesPassed: number;
  streak: number;
  lastActiveDate: string;
  badges: Badge[];
  longestStreak?: number;
  lastActivityDate?: string;
  streakFreezeCount?: number;
  weeklyPoints?: number;
  weeklyStartDate?: string;
  pinnedBadgeIds?: string[];
  profileAvatar?: string;
  profileAvatarType?: "preset" | "upload";
  recentActivity?: ScoreActivity[];
}

export interface Badge {
  id: string;
  name: string;
  description: string;
  icon: string;
  earnedAt: string;
}

export interface ScoreActivity {
  type: "lesson" | "challenge" | "quiz";
  title: string;
  completedAt: string;
  score?: number;
}

type BadgeDefinition = {
  id: string;
  name: string;
  description: string;
  icon: string;
};

type ScoreExtras = {
  longestStreak: number;
  lastActivityDate: string;
  streakFreezeCount: number;
  weeklyPoints: number;
  weeklyStartDate: string;
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
    description: "Earned 100% on an assessment.",
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="m12 3 2.4 4.9 5.4.8-3.9 3.8.9 5.4L12 15.9 7.2 18l.9-5.4L4.2 8.7l5.4-.8L12 3Z"></path></svg>',
  },
  comeback: {
    id: "comeback",
    name: "Comeback",
    description: "Passed after multiple failed attempts.",
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
    description: "Completed all 20 lessons.",
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="m3 10 9-5 9 5-9 5-9-5Z"></path><path d="M7 12.5V16c0 1.6 2.2 3 5 3s5-1.4 5-3v-3.5"></path></svg>',
  },
  champion: {
    id: "champion",
    name: "Champion",
    description: "Passed all 15 challenges.",
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M8 5h8v4a4 4 0 0 1-8 0V5Z"></path><path d="M6 7H4a2 2 0 0 0 2 2"></path><path d="M18 7h2a2 2 0 0 1-2 2"></path><path d="M12 13v4"></path><path d="M9 21h6"></path></svg>',
  },
  "on-fire": {
    id: "on-fire",
    name: "On Fire",
    description: "Reached a 3-day streak.",
    icon: "🔥",
  },
  "week-warrior": {
    id: "week-warrior",
    name: "Week Warrior",
    description: "Reached a 7-day streak and earned a streak freeze.",
    icon: "🛡️",
  },
  fortnight: {
    id: "fortnight",
    name: "Fortnight",
    description: "Reached a 14-day streak.",
    icon: "📅",
  },
  "month-master": {
    id: "month-master",
    name: "Month Master",
    description: "Reached a 30-day streak.",
    icon: "🏆",
  },
};

function decodeJwtUserId(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) {
      return null;
    }
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
    const maybeBuffer = (globalThis as typeof globalThis & {
      Buffer?: { from(input: string, encoding: string): { toString(encoding: string): string } };
    }).Buffer;
    const json =
      typeof atob === "function"
        ? atob(padded)
        : maybeBuffer?.from(padded, "base64").toString("utf8") ?? "";
    const payload = JSON.parse(json) as { sub?: unknown };
    return typeof payload.sub === "string" && payload.sub.trim().length > 0 ? payload.sub : null;
  } catch {
    return null;
  }
}

function currentScoreUserId(): string | null {
  if (typeof localStorage === "undefined" || typeof sessionStorage === "undefined") {
    return null;
  }
  const token = localStorage.getItem(ID_TOKEN_KEY) ?? sessionStorage.getItem(ID_TOKEN_KEY);
  return token ? decodeJwtUserId(token) : null;
}

function getScoreStorageKey(userId?: string | null): string {
  const scopedUserId = userId === undefined ? currentScoreUserId() : userId;
  return scopedUserId ? `${SCORE_STORAGE_KEY}:${scopedUserId}` : `${SCORE_STORAGE_KEY}:guest`;
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function weekStartIsoDate(date = new Date()): string {
  const utcDay = date.getUTCDay();
  const offset = utcDay === 0 ? 6 : utcDay - 1;
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - offset);
  return start.toISOString().slice(0, 10);
}

function shiftIsoDate(stamp: string, dayDelta: number): string {
  const parsed = parseDateStamp(stamp);
  if (parsed === null) {
    return stamp;
  }
  return new Date(parsed + dayDelta * MS_PER_DAY).toISOString().slice(0, 10);
}

function baseScore(): UserScore {
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

function emptyExtras(): ScoreExtras {
  return {
    longestStreak: 0,
    lastActivityDate: "",
    streakFreezeCount: 0,
    weeklyPoints: 0,
    weeklyStartDate: weekStartIsoDate(),
  };
}

function asFiniteNonNegative(value: unknown): number {
  return Number.isFinite(value) ? Math.max(0, Number(value)) : 0;
}

function attachExtras(score: UserScore, extrasInput?: Partial<ScoreExtras>): UserScore {
  const extras: ScoreExtras = {
    ...emptyExtras(),
    ...extrasInput,
  };

  Object.defineProperties(score, {
    longestStreak: {
      value: asFiniteNonNegative(extras.longestStreak),
      writable: true,
      enumerable: false,
      configurable: true,
    },
    lastActivityDate: {
      value: typeof extras.lastActivityDate === "string" ? extras.lastActivityDate : "",
      writable: true,
      enumerable: false,
      configurable: true,
    },
    streakFreezeCount: {
      value: Math.min(3, asFiniteNonNegative(extras.streakFreezeCount)),
      writable: true,
      enumerable: false,
      configurable: true,
    },
    weeklyPoints: {
      value: asFiniteNonNegative(extras.weeklyPoints),
      writable: true,
      enumerable: false,
      configurable: true,
    },
    weeklyStartDate: {
      value: typeof extras.weeklyStartDate === "string" && extras.weeklyStartDate ? extras.weeklyStartDate : weekStartIsoDate(),
      writable: true,
      enumerable: false,
      configurable: true,
    },
  });

  return score;
}

function getExtras(score: UserScore): ScoreExtras {
  return {
    longestStreak: asFiniteNonNegative(score.longestStreak),
    lastActivityDate:
      typeof score.lastActivityDate === "string" && score.lastActivityDate.length > 0
        ? score.lastActivityDate
        : typeof score.lastActiveDate === "string"
          ? score.lastActiveDate
          : "",
    streakFreezeCount: Math.min(3, asFiniteNonNegative(score.streakFreezeCount)),
    weeklyPoints: asFiniteNonNegative(score.weeklyPoints),
    weeklyStartDate:
      typeof score.weeklyStartDate === "string" && score.weeklyStartDate.length > 0
        ? score.weeklyStartDate
        : weekStartIsoDate(),
  };
}

function normalizeBadge(input: unknown): Badge | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const badge = input as Partial<Badge>;
  if (typeof badge.id !== "string") {
    return null;
  }
  return {
    id: badge.id,
    name: typeof badge.name === "string" ? badge.name : badge.id,
    description: typeof badge.description === "string" ? badge.description : "",
    icon: typeof badge.icon === "string" ? badge.icon : "🏅",
    earnedAt: typeof badge.earnedAt === "string" ? badge.earnedAt : new Date().toISOString(),
  };
}

function normalizeActivity(input: unknown): ScoreActivity | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const activity = input as Partial<ScoreActivity>;
  if ((activity.type !== "lesson" && activity.type !== "challenge" && activity.type !== "quiz") || typeof activity.title !== "string") {
    return null;
  }

  return {
    type: activity.type,
    title: activity.title,
    completedAt: typeof activity.completedAt === "string" && activity.completedAt ? activity.completedAt : new Date().toISOString(),
    score: Number.isFinite(activity.score) ? Number(activity.score) : undefined,
  };
}

function normalizeScore(input: unknown): UserScore {
  if (!input || typeof input !== "object") {
    return attachExtras(baseScore(), emptyExtras());
  }

  const raw = input as Partial<UserScore>;
  const score = baseScore();
  score.totalPoints = asFiniteNonNegative(raw.totalPoints);
  score.lessonPoints = asFiniteNonNegative(raw.lessonPoints);
  score.challengePoints = asFiniteNonNegative(raw.challengePoints);
  score.lessonsCompleted = asFiniteNonNegative(raw.lessonsCompleted);
  score.challengesPassed = asFiniteNonNegative(raw.challengesPassed);
  score.streak = asFiniteNonNegative(raw.streak);
  score.lastActiveDate = typeof raw.lastActiveDate === "string" ? raw.lastActiveDate : "";
  score.badges = Array.isArray(raw.badges)
    ? raw.badges.map(normalizeBadge).filter((badge): badge is Badge => Boolean(badge))
    : [];
  const pinnedBadgeIds = Array.isArray(raw.pinnedBadgeIds)
    ? raw.pinnedBadgeIds.filter((badgeId): badgeId is string => typeof badgeId === "string").slice(0, 3)
    : [];
  if (pinnedBadgeIds.length > 0) {
    score.pinnedBadgeIds = pinnedBadgeIds;
  }

  const profileAvatar = typeof raw.profileAvatar === "string" ? raw.profileAvatar.trim() : "";
  if (profileAvatar) {
    score.profileAvatar = profileAvatar;
  }

  if (raw.profileAvatarType === "preset" || raw.profileAvatarType === "upload") {
    score.profileAvatarType = raw.profileAvatarType;
  }

  const recentActivity = Array.isArray(raw.recentActivity)
    ? raw.recentActivity.map(normalizeActivity).filter((activity): activity is ScoreActivity => Boolean(activity)).slice(0, 10)
    : [];
  if (recentActivity.length > 0) {
    score.recentActivity = recentActivity;
  }

  return attachExtras(score, {
    longestStreak: raw.longestStreak,
    lastActivityDate: typeof raw.lastActivityDate === "string" ? raw.lastActivityDate : score.lastActiveDate,
    streakFreezeCount: raw.streakFreezeCount,
    weeklyPoints: raw.weeklyPoints,
    weeklyStartDate: raw.weeklyStartDate,
  });
}

function serializeScore(score: UserScore): Record<string, unknown> {
  const extras = getExtras(score);
  const serialized: Record<string, unknown> = {
    totalPoints: score.totalPoints,
    lessonPoints: score.lessonPoints,
    challengePoints: score.challengePoints,
    lessonsCompleted: score.lessonsCompleted,
    challengesPassed: score.challengesPassed,
    streak: score.streak,
    lastActiveDate: score.lastActiveDate,
    badges: score.badges,
    longestStreak: extras.longestStreak,
    lastActivityDate: extras.lastActivityDate,
    streakFreezeCount: extras.streakFreezeCount,
    weeklyPoints: extras.weeklyPoints,
    weeklyStartDate: extras.weeklyStartDate,
  };

  if (Array.isArray(score.pinnedBadgeIds) && score.pinnedBadgeIds.length > 0) {
    serialized.pinnedBadgeIds = score.pinnedBadgeIds;
  }
  if (typeof score.profileAvatar === "string" && score.profileAvatar.trim()) {
    serialized.profileAvatar = score.profileAvatar.trim();
  }
  if (score.profileAvatarType === "preset" || score.profileAvatarType === "upload") {
    serialized.profileAvatarType = score.profileAvatarType;
  }
  if (Array.isArray(score.recentActivity) && score.recentActivity.length > 0) {
    serialized.recentActivity = score.recentActivity;
  }

  return serialized;
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

function maybeResetWeeklyPoints(score: UserScore): void {
  const extras = getExtras(score);
  const currentWeek = weekStartIsoDate();
  if (extras.weeklyStartDate !== currentWeek) {
    score.weeklyPoints = 0;
    score.weeklyStartDate = currentWeek;
  }
}

function awardMilestoneBonus(score: UserScore): void {
  const milestoneMap: Record<number, { bonus: number; badgeId: string }> = {
    3: { bonus: 25, badgeId: "on-fire" },
    7: { bonus: 75, badgeId: "week-warrior" },
    14: { bonus: 150, badgeId: "fortnight" },
    30: { bonus: 400, badgeId: "month-master" },
  };

  const milestone = milestoneMap[score.streak];
  if (!milestone || badgeAlreadyEarned(score, milestone.badgeId)) {
    return;
  }

  addBadge(score, milestone.badgeId);
  score.totalPoints += milestone.bonus;
  score.lessonPoints += milestone.bonus;
  score.weeklyPoints = asFiniteNonNegative(score.weeklyPoints) + milestone.bonus;

  if (score.streak === 7) {
    score.streakFreezeCount = Math.min(3, asFiniteNonNegative(score.streakFreezeCount) + 1);
  }
}

export function loadScore(): UserScore {
  if (typeof localStorage === "undefined") {
    return attachExtras(baseScore(), emptyExtras());
  }

  const storageKey = getScoreStorageKey();
  let stored = localStorage.getItem(storageKey);
  if (!stored && storageKey === `${SCORE_STORAGE_KEY}:guest`) {
    stored = localStorage.getItem(LEGACY_SCORE_STORAGE_KEY);
    if (stored) {
      localStorage.setItem(storageKey, stored);
      localStorage.removeItem(LEGACY_SCORE_STORAGE_KEY);
    }
  }
  if (!stored) {
    return attachExtras(baseScore(), emptyExtras());
  }

  try {
    return normalizeScore(JSON.parse(stored) as unknown);
  } catch {
    return attachExtras(baseScore(), emptyExtras());
  }
}

export function saveScore(score: UserScore): void {
  if (typeof localStorage === "undefined") {
    return;
  }
  const storageKey = getScoreStorageKey();
  localStorage.setItem(storageKey, JSON.stringify(serializeScore(normalizeScore(score))));
  if (storageKey !== LEGACY_SCORE_STORAGE_KEY) {
    localStorage.removeItem(LEGACY_SCORE_STORAGE_KEY);
  }
}

export function setPinnedBadges(badgeIds: string[]): UserScore {
  const score = normalizeScore(loadScore());
  score.pinnedBadgeIds = badgeIds.filter((badgeId) => score.badges.some((badge) => badge.id === badgeId)).slice(0, 3);
  saveScore(score);
  return score;
}

export function setProfileAvatar(type: "preset" | "upload", value: string): UserScore {
  const score = normalizeScore(loadScore());
  score.profileAvatarType = type;
  score.profileAvatar = value.trim();
  saveScore(score);
  return score;
}

export function recordRecentActivity(activity: ScoreActivity): UserScore {
  const normalized = normalizeActivity(activity);
  const score = normalizeScore(loadScore());
  if (!normalized) {
    return score;
  }

  score.recentActivity = [
    normalized,
    ...(score.recentActivity ?? []).filter(
      (entry) => !(entry.type === normalized.type && entry.title === normalized.title && entry.completedAt === normalized.completedAt)
    ),
  ].slice(0, 10);
  saveScore(score);
  return score;
}

export function getScore(): UserScore {
  return loadScore();
}

export function checkAndUpdateStreak(score: UserScore): UserScore {
  const normalized = normalizeScore(score);
  const extras = getExtras(normalized);
  const today = todayIsoDate();
  const todayStamp = parseDateStamp(today);
  const lastStamp = parseDateStamp(extras.lastActivityDate || normalized.lastActiveDate);

  if (todayStamp === null || lastStamp === null) {
    return normalized;
  }

  const diffDays = Math.round((todayStamp - lastStamp) / MS_PER_DAY);
  if (diffDays <= 1) {
    return normalized;
  }

  if (extras.streakFreezeCount > 0) {
    normalized.streakFreezeCount = extras.streakFreezeCount - 1;
    const bridgedDate = shiftIsoDate(today, -1);
    normalized.lastActivityDate = bridgedDate;
    normalized.lastActiveDate = bridgedDate;
    return normalized;
  }

  normalized.streak = 0;
  normalized.lastActivityDate = "";
  normalized.lastActiveDate = "";
  return normalized;
}

export function recordActivity(score: UserScore): UserScore {
  const normalized = normalizeScore(score);
  maybeResetWeeklyPoints(normalized);

  const extras = getExtras(normalized);
  const today = todayIsoDate();
  const todayStamp = parseDateStamp(today);
  const lastStamp = parseDateStamp(extras.lastActivityDate || normalized.lastActiveDate);

  if (extras.lastActivityDate === today || normalized.lastActiveDate === today) {
    return normalized;
  }

  if (todayStamp !== null && lastStamp !== null) {
    const diffDays = Math.round((todayStamp - lastStamp) / MS_PER_DAY);
    if (diffDays === 1) {
      normalized.streak += 1;
      normalized.totalPoints += 10;
      normalized.lessonPoints += 10;
      normalized.weeklyPoints = asFiniteNonNegative(normalized.weeklyPoints) + 10;
    } else {
      normalized.streak = 1;
    }
  } else {
    normalized.streak = normalized.streak > 0 ? normalized.streak : 1;
  }

  if (normalized.streak > 0 && normalized.streak % 7 === 0) {
    normalized.streakFreezeCount = Math.min(3, asFiniteNonNegative(normalized.streakFreezeCount) + 1);
  }

  normalized.longestStreak = Math.max(asFiniteNonNegative(normalized.longestStreak), normalized.streak);
  normalized.lastActivityDate = today;
  normalized.lastActiveDate = today;
  awardMilestoneBonus(normalized);
  return normalized;
}

export function addPoints(amount: number, reason: string): void {
  const score = recordActivity(checkAndUpdateStreak(loadScore()));
  const granted = Math.max(0, amount);

  score.totalPoints += granted;
  score.weeklyPoints = asFiniteNonNegative(score.weeklyPoints) + granted;

  if (reason.toLowerCase().includes("challenge")) {
    score.challengePoints += granted;
  } else {
    score.lessonPoints += granted;
  }

  saveScore(score);
}

export function checkAndAwardBadges(progress: UserProgress, submissions: ChallengeSubmission[]): Badge[] {
  const score = normalizeScore(loadScore());
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
    ["graduate", completedLessons.length >= 20],
    ["champion", passedChallengeIds.size >= 15],
    ["on-fire", score.streak >= 3],
    ["week-warrior", score.streak >= 7],
    ["fortnight", score.streak >= 14],
    ["month-master", score.streak >= 30],
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
      body: JSON.stringify({
        ...serializeScore(normalizeScore(score)),
        referredBy: getStoredReferral(),
      }),
    });
  } catch {
    // Ignore sync failures so the local UX keeps moving.
  }
}
