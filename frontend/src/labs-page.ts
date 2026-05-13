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
          <p class="learn-hero__subhead">Full-function assembly assignments with real specs, visible and hidden tests, and graded submissions.</p>
        </div>
        <div class="learn-xp-pill">${loadScore().totalPoints.toLocaleString("en-US")} chips</div>
      </div>
      <div class="learn-hero__status">
        <div class="learn-hero__signin">
          <div class="learn-hero__signin-copy">${solved}/${labs.length} labs completed</div>
          <div class="learn-hero__signin-copy">Build full functions against a real test harness.</div>
        </div>
      </div>
    </section>
    <section class="labs-grid">
      ${labs
        .map((lab) => {
          const best = getBestLabSubmission(lab.id);
          const status = statusForLab(lab.id);
          const scoreText = best ? `${best.score}/${best.maxScore} pts` : "Not started";
          return `
            <a class="lab-card lab-card--${status}" href="/simulator/?lab=${escapeHtml(encodeURIComponent(lab.id))}">
              <div class="lab-card__accent"></div>
              <div class="lab-card__body">
                <div class="lab-card__header">
                  <span class="lab-card__num">LAB ${lab.number}</span>
                  <span class="lab-card__status-badge">${status === "complete" ? "✓ Complete" : status === "in-progress" ? "In progress" : "Not started"}</span>
                </div>
                <h2 class="lab-card__title">${escapeHtml(lab.title)}</h2>
                <p class="lab-card__desc">${escapeHtml(lab.description)}</p>
                <div class="lab-card__meta">
                  <span>${lab.estimatedMinutes} min</span>
                  <span>${lab.testCases.length} tests</span>
                  <span>${lab.totalPoints} pts</span>
                </div>
              </div>
              <div class="lab-card__footer">
                <span class="lab-card__score">${scoreText}</span>
                <span class="lab-card__cta">Open in Simulator →</span>
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
