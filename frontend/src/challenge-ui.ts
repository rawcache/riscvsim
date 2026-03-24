import { parseAssembly } from "./asm";
import type { UserSession } from "./auth";
import {
  getBestSubmission,
  getChallenge,
  getChallengesForLesson,
  loadChallengeSubmissions,
  saveChallengeSubmission,
  type Challenge,
  type ChallengeSubmission,
  type TestCase,
} from "./challenges";
import { escapeHtml } from "./format";
import { getLessonState, loadProgress } from "./lessons";
import { showNotification } from "./notifications";
import { buildReferralLink } from "./referrals";
import { addPoints, checkAndAwardBadges, loadScore, recordRecentActivity } from "./scoring";
import { createShareSection } from "./share-card-ui";
import { getCurrentWeekNumber, getWeeklyChallengeId } from "./weekly-challenge";
import { WasmRuntime } from "./wasm-runtime";

type LoadSourceOptions = {
  statusMessage?: string;
  focus?: boolean;
};

type ChallengeModeDependencies = {
  loadSource: (source: string, options?: LoadSourceOptions) => void;
  assembleSource: (showSpinner: boolean, successMessage: string) => Promise<boolean>;
  getCurrentSession: () => UserSession | null;
  getSource: () => string;
  showToast: (message: string) => void;
  setStatusMessage: (message: string) => void;
};

export interface ChallengeModeController {
  isActive(): boolean;
  prefillSource(): void;
  initialize(): Promise<void>;
  handleAssembled(): void;
  handleStep(recordAttempt?: boolean): void;
  handleStepBack(): void;
  handleRunEnd(): void;
  handleReset(): void;
  handleSessionChange(session: UserSession | null): Promise<void>;
}

const DEFAULT_API_ENDPOINT = "https://api.studyriscv.com";
const API_ENDPOINT = (import.meta.env.VITE_API_ENDPOINT as string | undefined)?.trim() || DEFAULT_API_ENDPOINT;
const MAX_CHALLENGE_STEPS = 2000;

function formatDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function syncScoreToApiFireAndForget(session: UserSession | null, extraBody?: Record<string, unknown>): void {
  if (!session || !API_ENDPOINT) {
    return;
  }
  const score = loadScore();
  void fetch(`${API_ENDPOINT}/leaderboard/score`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.idToken}`,
    },
    body: JSON.stringify({
      ...score,
      ...extraBody,
    }),
  }).catch(() => {});
}

function submissionCountForChallenge(challengeId: string): number {
  return loadChallengeSubmissions().filter((submission) => submission.challengeId === challengeId).length;
}

function generateSetupAssembly(testCase: TestCase): string {
  const lines: string[] = [".text", "__challenge_boot__:"];

  for (const [reg, value] of Object.entries(testCase.setup.registers ?? {})) {
    const index = Number(reg);
    if (!Number.isInteger(index) || index <= 0 || index >= 32) {
      continue;
    }
    lines.push(`  li x${index}, ${(value ?? 0) >>> 0}`);
  }

  for (const entry of testCase.setup.memory ?? []) {
    const address = entry.address >>> 0;
    const value = entry.value >>> 0;
    lines.push(`  li t6, ${address}`);
    lines.push(`  li t5, ${value}`);
    if (address % 4 === 0 && value > 0xff) {
      lines.push("  sw t5, 0(t6)");
    } else {
      lines.push("  sb t5, 0(t6)");
    }
  }

  if (testCase.setup.program_prefix && testCase.setup.program_prefix.trim().length > 0) {
    lines.push(testCase.setup.program_prefix.trim());
  } else {
    lines.push("  j challenge_start");
  }

  return lines.join("\n");
}

async function runTestCase(challenge: Challenge, code: string, testCase: TestCase) {
  const runtime = await WasmRuntime.create();
  runtime.setAlignmentChecks(true);

  const assembled = parseAssembly(
    `${generateSetupAssembly(testCase)}\n${code}\n.text\n__challenge_end__:\nbeq x0, x0, __challenge_end__\n`
  );

  runtime.loadProgram(assembled.instructions);
  runtime.reset();

  const deltas = [];
  let stalled = false;

  for (let step = 0; step < MAX_CHALLENGE_STEPS; step += 1) {
    const delta = runtime.step();
    deltas.push(delta);
    const pcEffect = delta.effects.find(
      (effect): effect is Extract<(typeof delta.effects)[number], { kind: "pc" }> => effect.kind === "pc"
    );
    if (delta.halted || delta.trap) {
      break;
    }
    if (pcEffect && pcEffect.before === pcEffect.after) {
      stalled = true;
      break;
    }
  }

  const state = getLessonState(deltas);
  if (stalled) {
    state.halted = true;
  }

  return {
    challenge,
    testCase,
    passed: testCase.check(state),
    state,
  };
}

export function createChallengeMode(deps: ChallengeModeDependencies): ChallengeModeController {
  const challengeId = new URLSearchParams(window.location.search).get("challenge");
  const challenge = challengeId ? getChallenge(challengeId) : null;

  if (!challenge) {
    return {
      isActive: () => false,
      prefillSource: () => {},
      initialize: async () => {},
      handleAssembled: () => {},
      handleStep: () => {},
      handleStepBack: () => {},
      handleRunEnd: () => {},
      handleReset: () => {},
      handleSessionChange: async () => {},
    };
  }

  const activeChallenge = challenge;

  const simulatorLayout = document.querySelector(".simulator-layout");
  const leftColumn = document.querySelector(".sim-column--left");
  const editorPanel = document.querySelector(".sim-panel--editor") as HTMLElement | null;
  const brandRow = document.querySelector(".sim-nav__brand-row");

  if (!(simulatorLayout instanceof HTMLElement) || !(leftColumn instanceof HTMLElement) || !(editorPanel instanceof HTMLElement)) {
    return {
      isActive: () => false,
      prefillSource: () => {},
      initialize: async () => {},
      handleAssembled: () => {},
      handleStep: () => {},
      handleStepBack: () => {},
      handleRunEnd: () => {},
      handleReset: () => {},
      handleSessionChange: async () => {},
    };
  }

  const desktopColumn = document.createElement("div");
  desktopColumn.className = "sim-column sim-column--lesson";
  const panel = document.createElement("section");
  panel.className = "sim-panel lesson-panel challenge-panel";
  panel.id = "challengeModePanel";
  desktopColumn.appendChild(panel);
  simulatorLayout.classList.add("has-lesson-column");
  document.body.classList.add("challenge-simulator-active");
  simulatorLayout.insertBefore(desktopColumn, leftColumn);

  const navIndicator = document.createElement("a");
  navIndicator.className = "lesson-nav-indicator";
  navIndicator.href = "/challenges/";
  navIndicator.textContent = `← ${activeChallenge.title}`;
  brandRow?.appendChild(navIndicator);

  let startedAt = performance.now();
  let pausedAt = 0;
  let pausedDuration = 0;
  let timer = 0;
  let hintVisible = false;
  let answerVisible = false;
  let submissionResults: ChallengeSubmission | null = getBestSubmission(activeChallenge.id);
  let currentSession: UserSession | null = deps.getCurrentSession();
  const weeklyChallengeId = getWeeklyChallengeId();
  const currentWeekNumber = getCurrentWeekNumber();

  function weeklyBonusStorageKey(): string {
    return `studyriscv_weekly_challenge_bonus:${currentWeekNumber}:${activeChallenge.id}`;
  }

  function elapsedSeconds(): number {
    const now = pausedAt || performance.now();
    return Math.max(0, Math.floor((now - startedAt - pausedDuration) / 1000));
  }

  function challengeSubmissionScore(submission: ChallengeSubmission): string {
    return `${submission.score} / ${submission.maxScore} points`;
  }

  function testCaseListMarkup(): string {
    return activeChallenge.testCases
      .map((testCase) => `<li class="challenge-panel__test-item">${escapeHtml(testCase.description)}</li>`)
      .join("");
  }

  function resultListMarkup(): string {
    if (!submissionResults) {
      return "";
    }
    return `
      <div class="challenge-results${submissionResults.passed ? " is-passed" : " is-failed"}">
        <div class="challenge-results__score">${challengeSubmissionScore(submissionResults)}</div>
        <div class="challenge-results__time">Time: ${formatDuration(submissionResults.timeSpentSeconds)}</div>
        <div class="challenge-results__list">
          ${submissionResults.testResults
            .map(
              (result) => `
                <div class="challenge-results__row ${result.passed ? "is-passed" : "is-failed"}">
                  <span>${result.passed ? "✓" : "✗"}</span>
                  <span>${escapeHtml(result.description)}</span>
                </div>
              `
            )
            .join("")}
        </div>
      </div>
    `;
  }

  function practiceLinksMarkup(): string {
    const related = getChallengesForLesson(activeChallenge.lessonId);
    if (related.length <= 1) {
      return "";
    }
    return `
      <div class="challenge-panel__related">
        <div class="challenge-panel__related-label">More practice in this lesson</div>
        ${related
          .filter((entry) => entry.id !== activeChallenge.id)
          .map((entry) => `<a class="challenge-panel__related-link" href="/simulator/?challenge=${encodeURIComponent(entry.id)}">${escapeHtml(entry.title)} →</a>`)
          .join("")}
      </div>
    `;
  }

  function render(): void {
    const elapsed = elapsedSeconds();
    const showHint = hintVisible || elapsed >= 180;
    const showAnswer = answerVisible || elapsed >= 600;

    panel.innerHTML = `
      <div class="panel-header lesson-panel__header">
        <div>
          <div class="lesson-panel__eyebrow">Challenge</div>
          <div class="lesson-panel__title">${escapeHtml(activeChallenge.title)} · ${activeChallenge.points} chips</div>
        </div>
      </div>
      <div class="lesson-panel__body challenge-panel__body">
        <div class="challenge-panel__description">${escapeHtml(activeChallenge.description)}</div>
        <div class="challenge-panel__section">
          <div class="challenge-panel__section-title">Tests</div>
          <ul class="challenge-panel__tests">${testCaseListMarkup()}</ul>
        </div>
        <div class="challenge-panel__section">
          <div class="challenge-panel__timer">Timer · ${formatDuration(elapsed)}</div>
        </div>
        ${
          showHint
            ? `<div class="lesson-callout lesson-callout--tip"><div class="lesson-callout__label">Hint</div><div class="lesson-callout__body">${escapeHtml(
                activeChallenge.hint
              )}</div></div>`
            : ""
        }
        ${
          answerVisible
            ? `<div class="challenge-answer">
                <div class="challenge-answer__label">Solution</div>
                <pre class="challenge-answer__code"><code>${escapeHtml(activeChallenge.solutionCode)}</code></pre>
              </div>`
            : ""
        }
        ${resultListMarkup()}
        ${submissionResults?.passed ? '<div id="challengeShareMount"></div>' : ""}
        ${practiceLinksMarkup()}
      </div>
      <div class="lesson-panel__footer challenge-panel__footer">
        <button class="lesson-finish-button challenge-submit-button" type="button" data-challenge-action="submit">Submit</button>
        ${
          !showHint
            ? ""
            : `<button class="challenge-secondary-button" type="button" data-challenge-action="hint">${hintVisible ? "Hint shown" : "Show hint"}</button>`
        }
        ${
          !showAnswer
            ? ""
            : `<button class="challenge-secondary-button" type="button" data-challenge-action="answer">${answerVisible ? "Answer shown" : "Show answer"}</button>`
        }
      </div>
    `;

    panel.querySelector<HTMLElement>("[data-challenge-action='submit']")?.addEventListener("click", () => {
      void submitCurrentCode();
    });
    panel.querySelector<HTMLElement>("[data-challenge-action='hint']")?.addEventListener("click", () => {
      hintVisible = true;
      render();
    });
    panel.querySelector<HTMLElement>("[data-challenge-action='answer']")?.addEventListener("click", () => {
      if (answerVisible || window.confirm("Reveal the answer? This costs 50% of the points for this challenge.")) {
        answerVisible = true;
        deps.loadSource(activeChallenge.solutionCode, {
          statusMessage: "Solution loaded. Points for this attempt will be reduced.",
          focus: false,
        });
        void deps.assembleSource(false, "Solution assembled.");
        render();
      }
    });

    if (submissionResults?.passed) {
      const shareMount = panel.querySelector<HTMLElement>("#challengeShareMount");
      if (shareMount) {
        shareMount.appendChild(
          createShareSection({
            card: {
              variant: "challenge",
              title: activeChallenge.title,
              subtitle: "Challenge cleared",
              stats: [
                { label: "Score", value: `${submissionResults.score}/${submissionResults.maxScore}` },
                { label: "Time", value: formatDuration(submissionResults.timeSpentSeconds) },
                { label: "Attempt", value: `${submissionCountForChallenge(activeChallenge.id)}` },
              ],
              badge: "⚡",
              streakDays: loadScore().streak,
              accentColor: "var(--success)",
            },
            filename: `${activeChallenge.id}.png`,
            link: currentSession ? buildReferralLink(currentSession.userId, "/challenges/") : "https://studyriscv.com/challenges/",
          })
        );
      }
    }
  }

  async function submitCurrentCode(): Promise<void> {
    deps.setStatusMessage("Running challenge tests…");
    const code = deps.getSource();
    const startedSubmitAt = performance.now();
    const results = await Promise.all(activeChallenge.testCases.map((testCase) => runTestCase(activeChallenge, code, testCase)));
    const elapsed = Math.max(elapsedSeconds(), Math.floor((performance.now() - startedSubmitAt) / 1000));
    const score = results.filter((result) => result.passed).reduce((total, result) => total + result.testCase.points, 0);
    const maxScore = activeChallenge.testCases.reduce((total, testCase) => total + testCase.points, 0);
    const passed = results.every((result) => result.passed);

    const submission: ChallengeSubmission = {
      challengeId: activeChallenge.id,
      userId: currentSession?.userId,
      code,
      passed,
      score: answerVisible ? 0 : score,
      maxScore,
      testResults: results.map((result) => ({
        testCaseId: result.testCase.id,
        passed: result.passed,
        description: result.testCase.description,
      })),
      submittedAt: new Date().toISOString(),
      timeSpentSeconds: elapsed,
      viewedAnswer: answerVisible,
    };

    saveChallengeSubmission(submission);
    submissionResults = submission;

    if (passed && !answerVisible) {
      const attemptCount = submissionCountForChallenge(activeChallenge.id);
      const firstTry = attemptCount === 1;
      const award = firstTry ? Math.round(activeChallenge.points * 1.5) : activeChallenge.points;
      let bonus = award + (submission.score === submission.maxScore ? 25 : 0);
      if (activeChallenge.id === weeklyChallengeId && typeof localStorage !== "undefined" && !localStorage.getItem(weeklyBonusStorageKey())) {
        localStorage.setItem(weeklyBonusStorageKey(), submission.submittedAt);
        bonus += 50;
        showNotification({
          id: `challenge-weekly-${activeChallenge.id}-${submission.submittedAt}`,
          type: "xp",
          title: "Weekly challenge complete",
          message: "+50 chip bonus",
          icon: "🏆",
          duration: 4000,
          accentColor: "var(--accent)",
        });
      }

      addPoints(bonus, `challenge:${activeChallenge.id}`);
      recordRecentActivity({
        type: "challenge",
        title: activeChallenge.title,
        completedAt: submission.submittedAt,
        score: submission.score,
      });
      checkAndAwardBadges(loadProgress(), loadChallengeSubmissions());
      syncScoreToApiFireAndForget(currentSession, {
        weeklyChallengeCompletion:
          activeChallenge.id === weeklyChallengeId
            ? {
                challengeId: activeChallenge.id,
                score: submission.score,
                timeSeconds: submission.timeSpentSeconds,
                weekNumber: currentWeekNumber,
              }
            : undefined,
      });
      showNotification({
        id: `challenge-${activeChallenge.id}-${submission.submittedAt}`,
        type: "challenge",
        title: "Challenge Passed!",
        message: `${activeChallenge.title} · +${bonus} chips`,
        icon: "✅",
        duration: 4000,
        accentColor: "var(--success)",
      });
      deps.showToast(`Challenge passed · ${submission.score}/${submission.maxScore}`);
    } else if (passed) {
      deps.showToast("Challenge passed, but answer view reduced this attempt to 0 points.");
    } else {
      deps.showToast(`Challenge score: ${submission.score}/${submission.maxScore}`);
    }

    deps.setStatusMessage(passed ? "Challenge passed." : "Challenge results ready.");
    render();
  }

  function startTimer(): void {
    window.clearInterval(timer);
    timer = window.setInterval(() => {
      render();
    }, 1000);
  }

  function handleVisibilityChange(): void {
    if (document.visibilityState === "hidden") {
      pausedAt = performance.now();
      window.clearInterval(timer);
      return;
    }
    if (pausedAt) {
      pausedDuration += performance.now() - pausedAt;
      pausedAt = 0;
    }
    startTimer();
    render();
  }

  document.addEventListener("visibilitychange", handleVisibilityChange);

  return {
    isActive: () => true,
    prefillSource() {
      deps.loadSource(activeChallenge.starterCode, {
        statusMessage: "Challenge starter loaded.",
        focus: false,
      });
    },
    async initialize() {
      this.prefillSource();
      await deps.assembleSource(false, "Challenge assembled.");
      startedAt = performance.now();
      pausedDuration = 0;
      pausedAt = 0;
      startTimer();
      render();
    },
    handleAssembled() {
      render();
    },
    handleStep() {
      render();
    },
    handleStepBack() {
      render();
    },
    handleRunEnd() {
      render();
    },
    handleReset() {
      render();
    },
    async handleSessionChange(session: UserSession | null) {
      currentSession = session;
    },
  };
}
