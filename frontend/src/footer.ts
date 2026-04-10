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
          <p class="site-footer__tagline">
            StudyRISC-V combines a browser-based RISC-V simulator with guided lessons, quizzes,
            checkpoints, and visual architecture explanations.
          </p>
        </div>
        <div>
          <div class="site-footer__heading">Product</div>
          <div class="site-footer__links">
            <a href="/simulator/">RISC-V simulator</a>
            <a href="/problems/">RISC-V assembly problems</a>
            <a href="/learn/">RISC-V lessons</a>
            <a href="/quiz/">RISC-V quizzes</a>
            <a href="/labs/">Architecture labs</a>
            <a href="/checkpoints/">RISC-V checkpoints</a>
            <a href="/leaderboard/">Learning leaderboard</a>
          </div>
        </div>
        <div>
          <div class="site-footer__heading">Guides</div>
          <div class="site-footer__links">
            <a href="/riscv-simulator/">What is a RISC-V simulator?</a>
            <a href="/learn-riscv/">Learn RISC-V</a>
            <a href="/riscv-assembly-tutorial/">RISC-V assembly tutorial</a>
            <a href="/riscv-instructions/">RISC-V instructions reference</a>
            <a href="/docs/">RISC-V documentation</a>
            <a href="/about/">About StudyRISC-V</a>
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
        <div class="site-footer__copyright">© 2026 StudyRISC-V. Interactive RISC-V simulator and learning platform.</div>
        <div class="site-footer__domain">studyriscv.com</div>
      </div>
    </div>
  `;
}
