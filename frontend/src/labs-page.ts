import { initFooter } from "./footer";
import { getBestLabSubmission, getLabs } from "./labs";
import { initNav } from "./nav";
import { loadScore } from "./scoring";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function statusForLab(labId: string): "not-started" | "in-progress" | "complete" {
  const best = getBestLabSubmission(labId);
  if (!best) {
    return "not-started";
  }
  return best.passed ? "complete" : "in-progress";
}

function renderLabs(): void {
  const root = document.getElementById("labsApp");
  if (!root) {
    return;
  }

  const labs = getLabs();
  const solved = labs.filter((lab) => statusForLab(lab.id) === "complete").length;

  root.innerHTML = `
    <section class="learn-hero">
      <div class="learn-hero__copy">
        <div>
          <h1 class="learn-hero__title">Labs</h1>
          <p class="learn-hero__subhead">Five open-ended ECE 2035-style assignments with visible tests, hidden tests, and graded submissions.</p>
        </div>
        <div class="learn-xp-pill">${loadScore().totalPoints.toLocaleString("en-US")} chips</div>
      </div>
      <div class="learn-hero__status">
        <div class="learn-hero__signin">
          <div class="learn-hero__signin-copy">${solved}/${labs.length} labs completed</div>
          <div class="learn-hero__signin-copy">Build full functions under real lab-style specs.</div>
        </div>
      </div>
    </section>
    <section class="labs-grid">
      ${labs
        .map((lab) => {
          const best = getBestLabSubmission(lab.id);
          const status = statusForLab(lab.id);
          return `
            <a class="challenge-card challenge-card--${status}" href="/simulator/?lab=${encodeURIComponent(lab.id)}">
              <div class="challenge-card__header">
                <span class="challenge-card__difficulty challenge-card__difficulty--medium">Lab ${lab.number}</span>
                <span class="challenge-card__points">${lab.totalPoints} pts</span>
              </div>
              <h2 class="challenge-card__title">${escapeHtml(lab.title)}</h2>
              <div class="challenge-card__lesson">${lab.estimatedMinutes} min · ${lab.testCases.length} tests</div>
              <p class="challenge-card__body">${escapeHtml(lab.description)}</p>
              <div class="challenge-card__footer">
                <span class="challenge-card__best">${best ? `${best.score}/${best.maxScore}` : "Not started"}</span>
                <span class="challenge-card__status-label">${status.replace("-", " ")}</span>
              </div>
            </a>
          `;
        })
        .join("")}
    </section>
  `;
}

document.addEventListener("DOMContentLoaded", () => {
  initNav({ activePage: "labs" });
  initFooter();
  renderLabs();
});
