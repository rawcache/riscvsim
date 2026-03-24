import { parseAssembly } from "./asm";
import type { UserSession } from "./auth";
import { initFooter } from "./footer";
import { escapeHtml } from "./format";
import { getLessonState } from "./lessons";
import { getBestLabSubmission, getLab, saveLabSubmission, type LabSubmission, type LabTestCase } from "./labs";
import { showNotification } from "./notifications";
import { addPoints, loadScore, syncScoreToApi } from "./scoring";
import { WasmRuntime } from "./wasm-runtime";

type LoadSourceOptions = {
  statusMessage?: string;
  focus?: boolean;
};

type LabModeDependencies = {
  loadSource: (source: string, options?: LoadSourceOptions) => void;
  assembleSource: (showSpinner: boolean, successMessage: string) => Promise<boolean>;
  getCurrentSession: () => UserSession | null;
  getSource: () => string;
  showToast: (message: string) => void;
  setStatusMessage: (message: string) => void;
};

export interface LabModeController {
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

const EXECUTION_LIMIT = 3000;

function markdownToHtml(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, '<code class="lesson-rich-code">$1</code>')
    .replace(/\n\n/g, "</p><p>")
    .replace(/\n/g, "<br />");
}

function buildSetupPrefix(testCase: LabTestCase): string {
  const lines = [".text", "__lab_boot__:"];
  for (const [reg, value] of Object.entries(testCase.setup.registers ?? {})) {
    const index = Number(reg);
    if (!Number.isInteger(index) || index < 0 || index > 31) {
      continue;
    }
    lines.push(`  li x${index}, ${(value ?? 0) >>> 0}`);
  }
  for (const block of testCase.setup.memory ?? []) {
    lines.push(`  li t6, ${block.address >>> 0}`);
    block.bytes.forEach((byte, index) => {
      lines.push(`  li t5, ${(byte ?? 0) & 0xFF}`);
      lines.push(`  sb t5, ${index}(t6)`);
    });
  }
  lines.push("  j lab_start");
  return lines.join("\n");
}

async function runLabTest(code: string, testCase: LabTestCase) {
  const runtime = await WasmRuntime.create();
  runtime.setAlignmentChecks(true);
  const assembled = parseAssembly(`${buildSetupPrefix(testCase)}\n${code}\n.text\n__lab_done__:\nbeq x0, x0, __lab_done__\n`);
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

  const state = getLessonState(deltas);
  return {
    passed: testCase.check(state),
    state,
  };
}

export function createLabMode(deps: LabModeDependencies): LabModeController {
  const labId = new URLSearchParams(window.location.search).get("lab");
  const resolvedLab = labId ? getLab(labId) : null;

  if (!resolvedLab) {
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
  const lab = resolvedLab;

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
  panel.className = "sim-panel lesson-panel lab-panel";
  desktopColumn.appendChild(panel);
  simulatorLayout.insertBefore(desktopColumn, leftColumn);

  const navIndicator = document.createElement("a");
  navIndicator.className = "lesson-nav-indicator";
  navIndicator.href = "/labs/";
  navIndicator.textContent = `← Lab ${lab.number} · ${lab.title}`;
  brandRow?.appendChild(navIndicator);

  let currentSession = deps.getCurrentSession();
  let startedAt = performance.now();
  let pausedAt = 0;
  let pausedDuration = 0;
  let timer = 0;
  let attempts = 0;
  const usedHints = new Set<string>();
  let bestSubmission = getBestLabSubmission(lab.id);
  let latestSubmission: LabSubmission | null = null;

  function elapsedSeconds(): number {
    const now = pausedAt || performance.now();
    return Math.max(0, Math.floor((now - startedAt - pausedDuration) / 1000));
  }

  function visibleHints() {
    return lab.hints.filter((hint) => elapsedSeconds() / 60 >= hint.unlockAfterMinutes || usedHints.has(hint.id));
  }

  function renderResults(): string {
    const submission = latestSubmission ?? bestSubmission;
    if (!submission) {
      return "";
    }
    return `
      <div class="challenge-results${submission.passed ? " is-passed" : " is-failed"}">
        <div class="challenge-results__score">${submission.score} / ${submission.maxScore} points</div>
        <div class="challenge-results__time">Time: ${submission.timeSpentSeconds}s · Attempts: ${submission.attempts}</div>
        <div class="challenge-results__list">
          ${submission.testResults
            .map(
              (result) => `
                <div class="challenge-results__row ${result.passed ? "is-passed" : "is-failed"}">
                  <span>${result.passed ? "✓" : "✗"}</span>
                  <span>${escapeHtml(result.testId)}</span>
                </div>
              `
            )
            .join("")}
        </div>
      </div>
    `;
  }

  function render(): void {
    const objectivesMarkup = lab.objectives.map((objective) => `<li>${escapeHtml(objective)}</li>`).join("");
    const visibleTestsMarkup = lab.testCases
      .filter((test) => !test.isHidden)
      .map((test) => `<li>${escapeHtml(test.description)}</li>`)
      .join("");
    const hintsMarkup = visibleHints()
      .map((hint) => {
        const label = usedHints.has(hint.id)
          ? `${escapeHtml(hint.title)} (${hint.costPoints} pts used)`
          : `${escapeHtml(hint.title)} (-${hint.costPoints} pts)`;
        const body = usedHints.has(hint.id)
          ? `<div class="lesson-callout lesson-callout--tip"><div class="lesson-callout__body">${escapeHtml(hint.content)}</div></div>`
          : "";
        return `<button type="button" class="challenge-secondary-button" data-lab-hint="${escapeHtml(hint.id)}">${label}</button>${body}`;
      })
      .join("");

    panel.innerHTML = `
      <div class="panel-header lesson-panel__header">
        <div>
          <div class="lesson-panel__eyebrow">Lab ${lab.number}</div>
          <div class="lesson-panel__title">${escapeHtml(lab.title)}</div>
        </div>
      </div>
      <div class="lesson-panel__body challenge-panel__body lab-panel__body">
        <div class="learn-xp-pill">${lab.totalPoints} pts · ${lab.estimatedMinutes} min</div>
        <div class="challenge-panel__description"><p>${markdownToHtml(lab.description)}</p></div>
        <div class="challenge-panel__section">
          <div class="challenge-panel__section-title">Signature</div>
          <pre class="challenge-answer__code"><code>${escapeHtml(lab.specification.signature)}</code></pre>
        </div>
        <div class="challenge-panel__section">
          <div class="challenge-panel__section-title">Objectives</div>
          <ul class="challenge-panel__tests">${objectivesMarkup}</ul>
        </div>
        <div class="challenge-panel__section">
          <div class="challenge-panel__section-title">Visible tests</div>
          <ul class="challenge-panel__tests">${visibleTestsMarkup}</ul>
        </div>
        <div class="challenge-panel__section">
          <div class="challenge-panel__section-title">Hints</div>
          <div class="lab-hints">${hintsMarkup}</div>
        </div>
        <div class="challenge-panel__timer">Timer · ${elapsedSeconds()}s</div>
        ${renderResults()}
      </div>
      <div class="lesson-panel__footer challenge-panel__footer">
        <button type="button" class="lesson-finish-button" data-lab-submit>Submit</button>
      </div>
    `;

    panel.querySelectorAll<HTMLButtonElement>("[data-lab-hint]").forEach((button) => {
      button.addEventListener("click", () => {
        const hintId = button.dataset.labHint;
        if (!hintId || usedHints.has(hintId)) {
          return;
        }
        usedHints.add(hintId);
        render();
      });
    });

    panel.querySelector<HTMLButtonElement>("[data-lab-submit]")?.addEventListener("click", () => {
      void submitLab();
    });
  }

  async function submitLab(): Promise<void> {
    deps.setStatusMessage("Running lab grader…");
    attempts += 1;
    const code = deps.getSource();
    const results: LabSubmission["testResults"] = [];
    let score = 0;

    for (const testCase of lab.testCases.filter((entry) => !entry.isHidden)) {
      const result = await runLabTest(code, testCase);
      results.push({ testId: testCase.id, passed: result.passed, hidden: false });
      if (result.passed) {
        score += testCase.points;
      }
    }

    render();

    for (const testCase of lab.testCases.filter((entry) => entry.isHidden)) {
      await new Promise((resolve) => window.setTimeout(resolve, 1000));
      const result = await runLabTest(code, testCase);
      results.push({ testId: testCase.id, passed: result.passed, hidden: true });
      if (result.passed) {
        score += testCase.points;
      }
      render();
    }

    const hintPenalty = Array.from(usedHints).reduce((total, hintId) => total + (lab.hints.find((hint) => hint.id === hintId)?.costPoints ?? 0), 0);
    const adjustedScore = Math.max(0, score - hintPenalty);
    const passed = results.every((result) => result.passed);

    latestSubmission = {
      labId: lab.id,
      code,
      score: adjustedScore,
      maxScore: lab.totalPoints,
      passed,
      testResults: results,
      hintsUsed: Array.from(usedHints),
      submittedAt: new Date().toISOString(),
      timeSpentSeconds: elapsedSeconds(),
      attempts,
    };

    saveLabSubmission(latestSubmission);
    bestSubmission = getBestLabSubmission(lab.id);

    if (passed) {
      addPoints(adjustedScore, `lab:${lab.id}`);
      if (currentSession?.idToken) {
        void syncScoreToApi(loadScore(), currentSession.idToken);
      }
      showNotification({
        id: `lab-${lab.id}-${latestSubmission.submittedAt}`,
        type: "lab",
        title: "Lab Complete!",
        message: `${lab.title} · +${adjustedScore} chips`,
        icon: "🧪",
        duration: 5000,
        accentColor: "var(--success)",
      });
      deps.showToast(`Lab passed · ${adjustedScore}/${lab.totalPoints}`);
    } else {
      deps.showToast(`Lab results ready · ${adjustedScore}/${lab.totalPoints}`);
    }

    deps.setStatusMessage(passed ? "Lab passed." : "Lab results ready.");
    render();
  }

  function startTimer(): void {
    window.clearInterval(timer);
    timer = window.setInterval(() => render(), 1000);
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
      startTimer();
      render();
    }
  }

  return {
    isActive: () => true,
    prefillSource() {
      deps.loadSource(lab.starterCode, {
        statusMessage: "Lab starter loaded.",
        focus: true,
      });
    },
    async initialize() {
      render();
      startTimer();
      document.addEventListener("visibilitychange", handleVisibilityChange);
      initFooter();
    },
    handleAssembled() {},
    handleStep() {},
    handleStepBack() {},
    handleRunEnd() {},
    handleReset() {},
    async handleSessionChange(session: UserSession | null) {
      currentSession = session;
    },
  };
}
