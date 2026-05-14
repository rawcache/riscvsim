import { parseAssembly } from "./asm";
import { getSession } from "./auth";
import { initFooter } from "./footer";
import { escapeHtml } from "./format";
import { getLessonState } from "./lessons";
import { initNav } from "./nav";
import { showNotification } from "./notifications";
import { buildReferralLink } from "./referrals";
import { addPoints, loadScore, recordRecentActivity, syncScoreToApi } from "./scoring";
import {
  autoSubmitQuiz,
  getQuiz,
  saveQuizAttempt,
  type Quiz,
  type QuizAnswerInput,
  type QuizAttempt,
  type QuizQuestion,
} from "./quiz";
import { createShareSection } from "./share-card-ui";
import { WasmRuntime } from "./wasm-runtime";

const EXECUTION_LIMIT = 2000;

type DraftAnswer = QuizAnswerInput & {
  code?: string;
};

type QuizRuntimeState = {
  quiz: Quiz;
  currentIndex: number;
  answers: Record<string, DraftAnswer>;
  startedAtIso: string;
  startedAtPerf: number;
  pausedAtPerf: number | null;
  pausedDurationMs: number;
  activeQuestionStartedAt: number;
  completed: QuizAttempt | null;
  timeExpired: boolean;
};

function percent(score: number, maxScore: number): number {
  if (maxScore === 0) {
    return 0;
  }
  return Math.round((score / maxScore) * 100);
}

function difficultyBadge(question: QuizQuestion): string {
  return `<span class="challenge-card__difficulty challenge-card__difficulty--${question.difficulty}">${escapeHtml(question.difficulty)}</span>`;
}


async function runAssemblyToState(code: string) {
  const runtime = await WasmRuntime.create();
  runtime.setAlignmentChecks(true);
  const assembled = parseAssembly(code);
  runtime.loadProgram(assembled.instructions);
  runtime.reset();
  const deltas = [];
  for (let step = 0; step < EXECUTION_LIMIT; step += 1) {
    const delta = runtime.step();
    deltas.push(delta);
    if (delta.halted || delta.trap) {
      break;
    }
  }
  return getLessonState(deltas);
}

type QuizCardDef = {
  id: string;
  topic: string;
  difficulty: "Beginner" | "Intermediate" | "Advanced";
  title: string;
  desc: string;
  questions: number;
  minutes: number;
  href: string;
};

const QUIZ_CARDS: QuizCardDef[] = [
  {
    id: "qc-1",
    topic: "Registers",
    difficulty: "Beginner",
    title: "Register File Basics",
    desc: "Learn how x0 through x31 work, why x0 is always zero, and how register aliasing works in RV32IM.",
    questions: 10,
    minutes: 8,
    href: "/quiz/?take=quiz-1-basics",
  },
  {
    id: "qc-2",
    topic: "Arithmetic",
    difficulty: "Beginner",
    title: "I-Type Arithmetic",
    desc: "addi, slti, andi, ori, xori — master the immediate-type arithmetic instructions.",
    questions: 12,
    minutes: 10,
    href: "/quiz/?take=quiz-4-bitwise",
  },
  {
    id: "qc-3",
    topic: "Memory",
    difficulty: "Intermediate",
    title: "Load and Store",
    desc: "lw, sw, lh, lb — understand byte addressing, sign extension, and memory alignment.",
    questions: 15,
    minutes: 12,
    href: "/quiz/?take=quiz-1-basics",
  },
  {
    id: "qc-4",
    topic: "Branching",
    difficulty: "Intermediate",
    title: "Control Flow",
    desc: "beq, bne, blt, bge — write correct branch conditions and understand PC-relative offsets.",
    questions: 12,
    minutes: 10,
    href: "/quiz/?take=quiz-2-midterm",
  },
  {
    id: "qc-5",
    topic: "Arithmetic",
    difficulty: "Intermediate",
    title: "M Extension Multiply",
    desc: "mul, mulh, div, rem — work with the multiplication and division extension.",
    questions: 10,
    minutes: 8,
    href: "/quiz/?take=quiz-4-bitwise",
  },
  {
    id: "qc-6",
    topic: "Memory",
    difficulty: "Advanced",
    title: "Stack Frames and Calling Convention",
    desc: "sp, ra, saved registers — implement correct function prologues and epilogues from scratch.",
    questions: 15,
    minutes: 15,
    href: "/quiz/?take=quiz-5-calling-convention",
  },
  {
    id: "qc-7",
    topic: "Branching",
    difficulty: "Advanced",
    title: "Jump Instructions",
    desc: "jal and jalr — understand link registers, indirect jumps, and return sequences.",
    questions: 10,
    minutes: 8,
    href: "/quiz/?take=quiz-2-midterm",
  },
  {
    id: "qc-8",
    topic: "Registers",
    difficulty: "Advanced",
    title: "Register Conventions Deep Dive",
    desc: "caller-saved vs callee-saved, a0-a7 argument passing, t0-t6 temporaries — the full ABI.",
    questions: 12,
    minutes: 10,
    href: "/quiz/?take=quiz-5-calling-convention",
  },
];

function difficultyDots(difficulty: QuizCardDef["difficulty"]): string {
  const count = difficulty === "Beginner" ? 1 : difficulty === "Intermediate" ? 2 : 3;
  return [1, 2, 3]
    .map((n) => `<span class="qp-card__dot${n <= count ? " qp-card__dot--filled" : ""}"></span>`)
    .join("");
}

function renderQuizCard(card: QuizCardDef): string {
  return `
    <a class="qp-card"
      href="${card.href}"
      data-difficulty="${escapeHtml(card.difficulty)}"
      data-topic="${escapeHtml(card.topic)}"
    >
      <div class="qp-card__top">
        <span class="qp-card__tag">${escapeHtml(card.topic)}</span>
        <span class="qp-card__dots">${difficultyDots(card.difficulty)}</span>
      </div>
      <h3 class="qp-card__title">${escapeHtml(card.title)}</h3>
      <p class="qp-card__desc">${escapeHtml(card.desc)}</p>
      <div class="qp-card__footer">
        <div class="qp-card__meta">
          <span class="qp-card__meta-item">${card.questions} questions</span>
          <span class="qp-card__meta-item">${card.minutes} min</span>
        </div>
        <span class="qp-card__arrow" aria-hidden="true"></span>
      </div>
    </a>
  `;
}

function renderQuizList(): void {
  const root = document.getElementById("quizApp");
  if (!root) {
    return;
  }

  const total = QUIZ_CARDS.length;

  root.innerHTML = `
    <div class="qp-wrap">
      <header class="qp-header">
        <div class="qp-header__overline">Quizzes</div>
        <h1 class="qp-header__h1">Test your knowledge.</h1>
        <p class="qp-header__sub">Timed quizzes covering every RV32IM concept. Track your score, see where you stand, and know when you're ready.</p>
        <hr class="qp-header__rule" />
      </header>

      <div class="qp-start">
        <div class="qp-start__overline">Start here</div>
        <h2 class="qp-start__heading">Find your starting point</h2>
        <p class="qp-start__desc">A quick 5-minute diagnostic that routes you to the right level — from total beginner to exam prep. No account required.</p>
        <a class="qp-start__btn" href="/quiz/?take=diagnostic">Take diagnostic quiz →</a>
      </div>

      <div class="qp-filter-bar">
        <div class="qp-pills" id="qpPills">
          <button class="qp-pill qp-pill--active" data-filter="all" type="button">All</button>
          <button class="qp-pill" data-filter="difficulty:Beginner" type="button">Beginner</button>
          <button class="qp-pill" data-filter="difficulty:Intermediate" type="button">Intermediate</button>
          <button class="qp-pill" data-filter="difficulty:Advanced" type="button">Advanced</button>
          <button class="qp-pill" data-filter="topic:Registers" type="button">Registers</button>
          <button class="qp-pill" data-filter="topic:Memory" type="button">Memory</button>
          <button class="qp-pill" data-filter="topic:Branching" type="button">Branching</button>
          <button class="qp-pill" data-filter="topic:Arithmetic" type="button">Arithmetic</button>
        </div>
        <span class="qp-count" id="qpCount">${total} quizzes</span>
      </div>

      <div class="qp-grid-wrap">
        <div class="qp-grid" id="qpGrid">
          ${QUIZ_CARDS.map(renderQuizCard).join("")}
        </div>
        <div class="qp-empty" id="qpEmpty" hidden>
          <div class="qp-empty__icon">?</div>
          <p class="qp-empty__text">No quizzes match this filter.</p>
          <button class="qp-empty__reset" id="qpEmptyReset" type="button">Clear filters</button>
        </div>
      </div>
    </div>
  `;

  // Filter logic
  const pills = root.querySelectorAll<HTMLButtonElement>(".qp-pill");
  const cards = root.querySelectorAll<HTMLElement>(".qp-card");
  const countEl = root.querySelector("#qpCount");
  const emptyEl = root.querySelector<HTMLElement>("#qpEmpty");
  const emptyReset = root.querySelector<HTMLButtonElement>("#qpEmptyReset");

  function applyFilter(filterValue: string): void {
    let visible = 0;
    cards.forEach((card) => {
      let show = true;
      if (filterValue !== "all") {
        const [type, value] = filterValue.split(":");
        if (type === "difficulty") {
          show = card.dataset.difficulty === value;
        } else if (type === "topic") {
          show = card.dataset.topic === value;
        }
      }
      card.hidden = !show;
      if (show) visible++;
    });

    if (countEl) {
      countEl.textContent = `${visible} quiz${visible === 1 ? "" : "zes"}`;
    }
    if (emptyEl instanceof HTMLElement) {
      emptyEl.hidden = visible > 0;
    }
  }

  pills.forEach((pill) => {
    pill.addEventListener("click", () => {
      pills.forEach((p) => p.classList.remove("qp-pill--active"));
      pill.classList.add("qp-pill--active");
      applyFilter(pill.dataset.filter ?? "all");
    });
  });

  if (emptyReset instanceof HTMLButtonElement) {
    emptyReset.addEventListener("click", () => {
      pills.forEach((p) => p.classList.remove("qp-pill--active"));
      const allPill = root.querySelector<HTMLButtonElement>("[data-filter='all']");
      allPill?.classList.add("qp-pill--active");
      applyFilter("all");
    });
  }
}

function currentElapsedSeconds(state: QuizRuntimeState): number {
  const now = state.pausedAtPerf ?? performance.now();
  return Math.max(0, Math.floor((now - state.startedAtPerf - state.pausedDurationMs) / 1000));
}

function questionDraft(state: QuizRuntimeState, questionId: string): DraftAnswer {
  return state.answers[questionId] ?? { answer: "", timeSpentSeconds: 0 };
}

function recordQuestionTime(state: QuizRuntimeState): void {
  const question = state.quiz.questions[state.currentIndex];
  if (!question) {
    return;
  }
  const elapsed = Math.max(0, Math.floor((performance.now() - state.activeQuestionStartedAt) / 1000));
  const existing = questionDraft(state, question.id);
  state.answers[question.id] = {
    ...existing,
    timeSpentSeconds: (existing.timeSpentSeconds ?? 0) + elapsed,
  };
  state.activeQuestionStartedAt = performance.now();
}

async function finalizeAssemblyAnswers(state: QuizRuntimeState): Promise<void> {
  for (const question of state.quiz.questions) {
    if (question.type !== "assembly") {
      continue;
    }
    const draft = questionDraft(state, question.id);
    const code = String(draft.answer ?? "");
    if (!code.trim()) {
      continue;
    }
    if (draft.state) {
      continue;
    }
    try {
      state.answers[question.id] = {
        ...draft,
        state: await runAssemblyToState(code),
      };
    } catch {
      state.answers[question.id] = {
        ...draft,
      };
    }
  }
}

async function completeQuiz(state: QuizRuntimeState): Promise<void> {
  recordQuestionTime(state);
  await finalizeAssemblyAnswers(state);
  const attempt = autoSubmitQuiz(state.quiz, state.answers);
  attempt.startedAt = state.startedAtIso;
  attempt.completedAt = new Date().toISOString();
  attempt.totalTimeSeconds = currentElapsedSeconds(state);
  saveQuizAttempt(attempt);
  state.completed = attempt;

  const award = attempt.passed ? attempt.score : Math.round(attempt.score * 0.5);
  if (award > 0) {
    addPoints(award, `quiz:${state.quiz.id}`);
    recordRecentActivity({
      type: "quiz",
      title: state.quiz.title,
      completedAt: attempt.completedAt,
      score: percent(attempt.score, attempt.maxScore),
    });
    const session = await getSession();
    if (session?.idToken) {
      void syncScoreToApi(loadScore(), session.idToken);
    }
    showNotification({
      id: `quiz-${state.quiz.id}-${attempt.completedAt}`,
      type: "quiz",
      title: `Quiz Complete · ${percent(attempt.score, attempt.maxScore)}%`,
      message: `${attempt.passed ? "Passed" : "Review complete"} · +${award} chips`,
      icon: "📝",
      duration: 5000,
      accentColor: "var(--accent)",
    });
  }
  renderQuizRuntime(state);
}

function renderReview(state: QuizRuntimeState): string {
  const attempt = state.completed;
  if (!attempt) {
    return "";
  }

  return `
    <section class="learn-panel quiz-results">
      <div class="learn-panel__header-row">
        <h2 class="learn-panel__title">${percent(attempt.score, attempt.maxScore)}% · ${attempt.passed ? "Passed" : "Needs review"}</h2>
        <div class="learn-panel__meta">${attempt.score}/${attempt.maxScore} points · ${attempt.totalTimeSeconds}s</div>
      </div>
      <div class="quiz-results__actions">
        <a class="learn-panel__link" href="/quiz/">Back to Quizzes</a>
        <a class="learn-panel__link" href="/quiz/?take=${encodeURIComponent(state.quiz.id)}">Retake Quiz</a>
      </div>
      <div id="quizShareMount"></div>
      <div class="quiz-review">
        ${state.quiz.questions
          .map((question) => {
            const result = attempt.answers[question.id];
            const answerText =
              question.type === "mcq"
                ? question.choices?.[Number(result?.answer)] ?? "Unanswered"
                : String(result?.answer ?? "Unanswered");
            return `
              <article class="quiz-review__item">
                <div class="quiz-review__header">
                  <span class="challenge-card__points">${question.points} pts</span>
                  ${difficultyBadge(question)}
                </div>
                <h3 class="quiz-review__title">${escapeHtml(question.prompt)}</h3>
                <div class="quiz-review__answer ${result?.correct ? "is-correct" : "is-wrong"}">
                  Your answer: ${escapeHtml(answerText)}
                </div>
                ${
                  question.explanation
                    ? `<p class="quiz-review__explanation">${escapeHtml(question.explanation)}</p>`
                    : ""
                }
              </article>
            `;
          })
          .join("")}
      </div>
    </section>
  `;
}

function renderQuestionBody(state: QuizRuntimeState, question: QuizQuestion): string {
  const draft = questionDraft(state, question.id);
  if (question.type === "mcq") {
    return `
      <div class="quiz-question__choices">
        ${question.choices
          ?.map(
            (choice, index) => `
              <button type="button" class="quiz-choice${Number(draft.answer) === index ? " is-selected" : ""}" data-quiz-choice="${index}">
                <span>${String.fromCharCode(65 + index)}</span>
                <span>${escapeHtml(choice)}</span>
              </button>
            `
          )
          .join("") ?? ""}
      </div>
    `;
  }

  if (question.type === "trace") {
    return `
      <pre class="challenge-answer__code"><code>${escapeHtml(question.traceCode ?? "")}</code></pre>
      <div class="quiz-input-row">
        <label class="learn-panel__meta" for="quizTraceInput">Answer</label>
        <input id="quizTraceInput" class="leaderboard-search" type="number" value="${escapeHtml(String(draft.answer ?? ""))}" />
      </div>
    `;
  }

  if (question.type === "fill-blank") {
    return `
      <div class="quiz-fill-blank">${escapeHtml(question.blankPrompt ?? "")}</div>
      <div class="quiz-input-row">
        <label class="learn-panel__meta" for="quizBlankInput">Fill the blank</label>
        <input id="quizBlankInput" class="leaderboard-search" type="text" value="${escapeHtml(String(draft.answer ?? ""))}" />
      </div>
    `;
  }

  return `
    <textarea id="quizAssemblyInput" class="source-textarea quiz-assembly" spellcheck="false">${escapeHtml(String(draft.answer ?? question.starterCode ?? ""))}</textarea>
    <div class="quiz-input-row quiz-input-row--actions">
      <button type="button" class="quiz-action-button quiz-action-button--primary quiz-action-button--check" data-quiz-assembly-check>Check Answer</button>
      <span class="learn-panel__meta" id="quizAssemblyStatus">${
        draft.state && question.check?.(draft.state) ? "Current code passes this question." : "Run your code to validate it."
      }</span>
    </div>
  `;
}

function renderQuizRuntime(state: QuizRuntimeState): void {
  const root = document.getElementById("quizApp");
  const nav = document.getElementById("site-nav");
  const footer = document.getElementById("site-footer");
  if (!root || !nav || !footer) {
    return;
  }

  nav.hidden = true;
  footer.hidden = true;
  document.body.classList.add("quiz-taking");

  if (state.completed) {
    root.innerHTML = renderReview(state);
    const shareMount = root.querySelector<HTMLElement>("#quizShareMount");
    if (shareMount) {
      void getSession().then((session) => {
        shareMount.innerHTML = "";
        shareMount.appendChild(
          createShareSection({
            card: {
              variant: "quiz",
              title: state.quiz.title,
              subtitle: `${percent(state.completed!.score, state.completed!.maxScore)}% · ${state.completed!.passed ? "Passed" : "Review complete"}`,
              stats: [
                { label: "Score", value: `${percent(state.completed!.score, state.completed!.maxScore)}%` },
                { label: "Time", value: `${state.completed!.totalTimeSeconds}s` },
              ],
              badge: "📝",
              streakDays: loadScore().streak,
              accentColor: state.completed!.passed ? "var(--success)" : "var(--accent)",
            },
            filename: `${state.quiz.id}.png`,
            link: session ? buildReferralLink(session.userId, "/quiz/") : "https://studyriscv.com/quiz/",
          })
        );
      });
    }
    return;
  }

  const question = state.quiz.questions[state.currentIndex];
  const elapsed = currentElapsedSeconds(state);
  const remaining = Math.max(0, state.quiz.timeLimitSeconds - elapsed);
  const answeredCount = Object.values(state.answers).filter((entry) => String(entry.answer ?? "").trim().length > 0).length;

  root.innerHTML = `
    <section class="quiz-session">
      <header class="quiz-session__header">
        <div class="quiz-session__title">${escapeHtml(state.quiz.title)}</div>
        <div class="quiz-session__progress">Question ${state.currentIndex + 1} of ${state.quiz.questions.length}</div>
        <div class="quiz-session__timer${remaining <= 60 ? " is-danger" : ""}">${Math.floor(remaining / 60)
          .toString()
          .padStart(2, "0")}:${(remaining % 60).toString().padStart(2, "0")}</div>
      </header>
      <article class="learn-panel quiz-question">
        <div class="quiz-question__meta">
          <span class="learn-xp-pill">Q${state.currentIndex + 1}</span>
          ${difficultyBadge(question)}
          <span class="challenge-card__points">+${question.points} pts</span>
        </div>
        <h2 class="quiz-question__prompt">${escapeHtml(question.prompt)}</h2>
        ${renderQuestionBody(state, question)}
        <div class="quiz-question__nav">
          <button type="button" class="quiz-action-button quiz-action-button--secondary" data-quiz-prev ${state.currentIndex === 0 ? "disabled" : ""}>← Previous</button>
          <div class="quiz-question__dots">
            ${state.quiz.questions
              .map((item, index) => {
                const answered = String(questionDraft(state, item.id).answer ?? "").trim().length > 0;
                return `<button type="button" class="quiz-dot${index === state.currentIndex ? " is-current" : ""}${answered ? " is-answered" : ""}" data-quiz-jump="${index}"></button>`;
              })
              .join("")}
          </div>
          <button type="button" class="quiz-action-button quiz-action-button--primary" data-quiz-next>${state.currentIndex === state.quiz.questions.length - 1 ? "Finish →" : "Next →"}</button>
        </div>
        <div class="quiz-submit-row">
          <button type="button" class="quiz-action-button quiz-action-button--primary quiz-action-button--submit" data-quiz-submit ${answeredCount < state.quiz.questions.length ? "disabled" : ""}>Submit Quiz</button>
        </div>
      </article>
    </section>
  `;

  if (question.type === "mcq") {
    root.querySelectorAll<HTMLButtonElement>("[data-quiz-choice]").forEach((button) => {
      button.addEventListener("click", () => {
        state.answers[question.id] = {
          ...questionDraft(state, question.id),
          answer: Number(button.dataset.quizChoice ?? 0),
        };
        renderQuizRuntime(state);
      });
    });
  }

  if (question.type === "trace") {
    root.querySelector<HTMLInputElement>("#quizTraceInput")?.addEventListener("input", (event) => {
      const target = event.currentTarget as HTMLInputElement;
      state.answers[question.id] = {
        ...questionDraft(state, question.id),
        answer: target.value,
      };
    });
  }

  if (question.type === "fill-blank") {
    root.querySelector<HTMLInputElement>("#quizBlankInput")?.addEventListener("input", (event) => {
      const target = event.currentTarget as HTMLInputElement;
      state.answers[question.id] = {
        ...questionDraft(state, question.id),
        answer: target.value,
      };
    });
  }

  if (question.type === "assembly") {
    root.querySelector<HTMLTextAreaElement>("#quizAssemblyInput")?.addEventListener("input", (event) => {
      const target = event.currentTarget as HTMLTextAreaElement;
      state.answers[question.id] = {
        ...questionDraft(state, question.id),
        answer: target.value,
        state: undefined,
      };
    });

    root.querySelector<HTMLButtonElement>("[data-quiz-assembly-check]")?.addEventListener("click", async () => {
      const draft = questionDraft(state, question.id);
      try {
        const nextState = await runAssemblyToState(String(draft.answer ?? ""));
        state.answers[question.id] = {
          ...draft,
          state: nextState,
        };
        renderQuizRuntime(state);
      } catch {
        const status = root.querySelector("#quizAssemblyStatus");
        if (status) {
          status.textContent = "Assembly did not compile or run cleanly.";
        }
      }
    });
  }

  root.querySelector<HTMLButtonElement>("[data-quiz-prev]")?.addEventListener("click", () => {
    recordQuestionTime(state);
    state.currentIndex = Math.max(0, state.currentIndex - 1);
    renderQuizRuntime(state);
  });

  root.querySelector<HTMLButtonElement>("[data-quiz-next]")?.addEventListener("click", async () => {
    recordQuestionTime(state);
    if (state.currentIndex === state.quiz.questions.length - 1) {
      await completeQuiz(state);
      return;
    }
    state.currentIndex = Math.min(state.quiz.questions.length - 1, state.currentIndex + 1);
    renderQuizRuntime(state);
  });

  root.querySelectorAll<HTMLButtonElement>("[data-quiz-jump]").forEach((button) => {
    button.addEventListener("click", () => {
      recordQuestionTime(state);
      state.currentIndex = Number(button.dataset.quizJump ?? 0);
      renderQuizRuntime(state);
    });
  });

  root.querySelector<HTMLButtonElement>("[data-quiz-submit]")?.addEventListener("click", async () => {
    await completeQuiz(state);
  });
}

function startQuiz(quiz: Quiz): void {
  const state: QuizRuntimeState = {
    quiz,
    currentIndex: 0,
    answers: {},
    startedAtIso: new Date().toISOString(),
    startedAtPerf: performance.now(),
    pausedAtPerf: null,
    pausedDurationMs: 0,
    activeQuestionStartedAt: performance.now(),
    completed: null,
    timeExpired: false,
  };

  const onVisibility = () => {
    if (state.completed) {
      return;
    }
    if (document.visibilityState === "hidden") {
      state.pausedAtPerf = performance.now();
      return;
    }
    if (state.pausedAtPerf !== null) {
      state.pausedDurationMs += performance.now() - state.pausedAtPerf;
      state.pausedAtPerf = null;
      renderQuizRuntime(state);
    }
  };

  document.addEventListener("visibilitychange", onVisibility);

  const timer = window.setInterval(() => {
    if (state.completed) {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      return;
    }
    const remaining = state.quiz.timeLimitSeconds - currentElapsedSeconds(state);
    if (remaining <= 0) {
      state.timeExpired = true;
      void completeQuiz(state);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      return;
    }
    renderQuizRuntime(state);
  }, 250);

  renderQuizRuntime(state);
}

document.addEventListener("DOMContentLoaded", () => {
  initNav({ activePage: "quiz" });
  initFooter();

  const quizId = new URLSearchParams(window.location.search).get("take");
  const quiz = quizId ? getQuiz(quizId) : null;
  if (quiz) {
    startQuiz(quiz);
    return;
  }

  renderQuizList();
});
