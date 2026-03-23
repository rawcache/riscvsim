function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function initFooter(): void {
  const footer = document.getElementById("site-footer");
  if (!footer) {
    return;
  }

  footer.className = "site-footer";
  footer.innerHTML = `
    <div class="site-footer__inner">
      <div class="site-footer__grid">
        <div>
          <div class="site-footer__brand">${escapeHtml("StudyRISC-V")}</div>
          <p class="site-footer__tagline">Built for engineers who want to understand the machine.</p>
        </div>
        <div>
          <div class="site-footer__heading">Navigate</div>
          <div class="site-footer__links">
            <a href="/learn/">Learn</a>
            <a href="/quiz/">Quizzes</a>
            <a href="/labs/">Labs</a>
            <a href="/challenges/">Challenges</a>
            <a href="/simulator/">Simulator</a>
            <a href="/leaderboard/">Leaderboard</a>
            <a href="/about/">About</a>
            <a href="/docs/">Docs</a>
            <a href="https://github.com/rawcache/riscvsim" target="_blank" rel="noopener">GitHub</a>
          </div>
        </div>
        <div>
          <div class="site-footer__heading">Legal</div>
          <div class="site-footer__links">
            <a href="/terms/">Terms of service</a>
            <a href="/privacy/">Privacy policy</a>
            <a href="/privacy/#do-not-sell">Do not sell my personal information</a>
          </div>
        </div>
      </div>
      <div class="site-footer__bottom">
        <div class="site-footer__copyright">© 2026 StudyRISC-V. Built by Satchit Seth.</div>
        <div class="site-footer__domain">studyriscv.com</div>
      </div>
    </div>
  `;
}
