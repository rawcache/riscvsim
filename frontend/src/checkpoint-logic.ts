import type { UserSession } from "./auth";
import type { CheckpointProblem, CheckpointProgress, CheckpointSubmission, Tier } from "./checkpoint-data";
import { getLessons, type UserProgress } from "./lessons";

export type CheckpointCardState = "locked" | "locked-tier" | "unlocked" | "completed";

function lessonIdByNumberMap(): Map<number, string> {
  return new Map(getLessons().map((lesson, index) => [index + 1, lesson.id]));
}

function tierRank(tier: Tier): number {
  switch (tier) {
    case "Guest":
      return 0;
    case "Free":
      return 1;
    case "Pro":
      return 2;
  }
}

export function getCurrentCheckpointTier(session: UserSession | null): Tier {
  if (!session) {
    return "Guest";
  }
  return session.isGtStudent ? "Pro" : "Free";
}

export function checkpointTierAllows(requiredTier: Tier, currentTier: Tier): boolean {
  return tierRank(currentTier) >= tierRank(requiredTier);
}

export function getLessonIdForNumber(lessonNumber: number): string | undefined {
  return lessonIdByNumberMap().get(lessonNumber);
}

export function areCheckpointLessonsUnlocked(problem: CheckpointProblem, progress: UserProgress): boolean {
  const lessonIds = lessonIdByNumberMap();
  return problem.unlocksAfterLessons.every((lessonNumber) => {
    const lessonId = lessonIds.get(lessonNumber);
    return lessonId ? progress.lessons[lessonId]?.completed === true : false;
  });
}

export function countCompletedRequiredLessons(problem: CheckpointProblem, progress: UserProgress): number {
  const lessonIds = lessonIdByNumberMap();
  return problem.unlocksAfterLessons.filter((lessonNumber) => {
    const lessonId = lessonIds.get(lessonNumber);
    return lessonId ? progress.lessons[lessonId]?.completed === true : false;
  }).length;
}

export function formatLessonRange(problem: CheckpointProblem): string {
  const first = problem.unlocksAfterLessons[0];
  const last = problem.unlocksAfterLessons[problem.unlocksAfterLessons.length - 1];
  if (first === undefined || last === undefined) {
    return "";
  }
  return first === last ? `${first}` : `${first}-${last}`;
}

export function isCheckpointCompleted(problemId: string, checkpointProgress: CheckpointProgress): boolean {
  return checkpointProgress[problemId]?.completed === true;
}

export function getCheckpointBestSubmission(
  problemId: string,
  checkpointProgress: CheckpointProgress
): CheckpointSubmission | undefined {
  return checkpointProgress[problemId]?.bestSubmission;
}

export function getCheckpointAllSubmissions(problemId: string, checkpointProgress: CheckpointProgress): CheckpointSubmission[] {
  return checkpointProgress[problemId]?.allSubmissions ?? [];
}

export function getCheckpointAcceptanceRate(
  problemId: string,
  checkpointProgress: CheckpointProgress
): number | null {
  const submissions = getCheckpointAllSubmissions(problemId, checkpointProgress);
  if (submissions.length === 0) {
    return null;
  }
  const acceptedCount = submissions.filter((submission) => submission.verdict === "Accepted").length;
  return Math.round((acceptedCount / submissions.length) * 100);
}

export function getCheckpointCardState(
  problem: CheckpointProblem,
  lessonProgress: UserProgress,
  checkpointProgress: CheckpointProgress,
  session: UserSession | null
): CheckpointCardState {
  if (isCheckpointCompleted(problem.id, checkpointProgress)) {
    return "completed";
  }
  if (!areCheckpointLessonsUnlocked(problem, lessonProgress)) {
    return "locked";
  }
  if (!checkpointTierAllows(problem.requiredTier, getCurrentCheckpointTier(session))) {
    return "locked-tier";
  }
  return "unlocked";
}

export function checkpointMilestone(problem: CheckpointProblem): number {
  return problem.unlocksAfterLessons[problem.unlocksAfterLessons.length - 1] ?? 0;
}

export function checkpointXp(problem: CheckpointProblem): number {
  switch (problem.difficulty) {
    case "Easy":
      return 30;
    case "Medium":
      return 80;
    case "Hard":
      return 140;
  }
}
