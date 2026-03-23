import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  autoSubmitQuiz,
  getQuizzes,
  getQuiz,
  gradeQuizAttempt,
  loadQuizAttempts,
  saveQuizAttempt,
  type QuizAttempt,
} from "../../src/quiz";

function createStorageMock(): Storage {
  const store = new Map<string, string>();

  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key) ?? null : null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
  };
}

const originalLocalStorage = globalThis.localStorage;

describe("quiz.ts", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: createStorageMock(),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: originalLocalStorage,
    });
  });

  it("getQuizzes returns exactly 5 quizzes", () => {
    expect(getQuizzes()).toHaveLength(5);
  });

  it("each quiz has at least 5 questions", () => {
    expect(getQuizzes().every((quiz) => quiz.questions.length >= 5)).toBe(true);
  });

  it("MCQ questions have exactly 4 choices", () => {
    const mcqs = getQuizzes().flatMap((quiz) => quiz.questions).filter((question) => question.type === "mcq");
    expect(mcqs.every((question) => question.choices?.length === 4)).toBe(true);
  });

  it("assembly questions have a check function", () => {
    const assemblyQuestions = getQuizzes().flatMap((quiz) => quiz.questions).filter((question) => question.type === "assembly");
    expect(assemblyQuestions.every((question) => typeof question.check === "function")).toBe(true);
  });

  it("saveQuizAttempt / loadQuizAttempts round-trips", () => {
    const attempt: QuizAttempt = {
      quizId: "quiz-1-basics",
      answers: {},
      score: 50,
      maxScore: 100,
      passed: false,
      startedAt: "2026-03-23T00:00:00.000Z",
      completedAt: "2026-03-23T00:05:00.000Z",
      totalTimeSeconds: 300,
    };

    saveQuizAttempt(attempt);
    expect(loadQuizAttempts()).toEqual([attempt]);
  });

  it("score calculation is correct for partial credit", () => {
    const quiz = getQuiz("quiz-1-basics");
    expect(quiz).not.toBeNull();
    if (!quiz) return;

    const attempt = gradeQuizAttempt(quiz, {
      "quiz1-q1": { answer: 0, timeSpentSeconds: 5 },
      "quiz1-q2": { answer: 1, timeSpentSeconds: 5 },
      "quiz1-q3": { answer: 999, timeSpentSeconds: 5 },
    });

    expect(attempt.score).toBe(30);
    expect(attempt.answers["quiz1-q1"]?.correct).toBe(true);
    expect(attempt.answers["quiz1-q3"]?.correct).toBe(false);
  });

  it("timer auto-submit marks unanswered questions wrong", () => {
    const quiz = getQuiz("quiz-1-basics");
    expect(quiz).not.toBeNull();
    if (!quiz) return;

    const attempt = autoSubmitQuiz(quiz, {
      "quiz1-q1": { answer: 0, timeSpentSeconds: 5 },
    });

    expect(attempt.answers["quiz1-q1"]?.correct).toBe(true);
    expect(attempt.answers["quiz1-q2"]?.correct).toBe(false);
    expect(attempt.answers["quiz1-q10"]?.correct).toBe(false);
  });
});
