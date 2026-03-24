import { showNotification } from "./notifications";
import { downloadCardAsPNG, generateShareCard, type ShareCard } from "./share-card";

type ShareSectionOptions = {
  card: ShareCard;
  filename: string;
  link: string;
};

export function createShareSection(options: ShareSectionOptions): HTMLElement {
  const root = document.createElement("section");
  root.className = "share-card-section";

  const title = document.createElement("div");
  title.className = "share-card-section__title";
  title.textContent = "Share your progress";

  const meta = document.createElement("div");
  meta.className = "share-card-section__meta";
  meta.textContent = "Download a PNG, take a screenshot, or copy your referral link.";

  const preview = document.createElement("div");
  preview.className = "share-card-preview";
  const previewInner = document.createElement("div");
  previewInner.className = "share-card-preview__inner";
  previewInner.appendChild(generateShareCard(options.card));
  preview.appendChild(previewInner);

  const actions = document.createElement("div");
  actions.className = "share-card-actions";

  const downloadBtn = document.createElement("button");
  downloadBtn.type = "button";
  downloadBtn.className = "share-card-action share-card-action--primary";
  downloadBtn.textContent = "Download PNG";
  downloadBtn.addEventListener("click", () => {
    void downloadCardAsPNG(options.card, options.filename);
  });

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "share-card-action";
  copyBtn.textContent = "Copy link";
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(options.link);
      showNotification({
        id: `share-link-${Date.now()}`,
        type: "badge",
        title: "Share link copied",
        message: options.link,
        icon: "🔗",
        duration: 3000,
        accentColor: "var(--accent)",
      });
    } catch {
      window.prompt("Copy this StudyRISC-V link", options.link);
    }
  });

  actions.append(downloadBtn, copyBtn);
  root.append(title, meta, preview, actions);
  return root;
}
