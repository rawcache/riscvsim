import { highlightMatch, search } from "./search";

type SearchOverlayElements = {
  overlay: HTMLDivElement;
  backdrop: HTMLDivElement;
  panel: HTMLDivElement;
  input: HTMLInputElement;
  results: HTMLDivElement;
  empty: HTMLDivElement;
  emptyQuery: HTMLSpanElement;
};

let elements: SearchOverlayElements | null = null;
let selectedIndex = 0;
let previousFocus: HTMLElement | null = null;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function ensureOverlay(): SearchOverlayElements {
  if (elements) {
    return elements;
  }

  const overlay = document.createElement("div");
  overlay.id = "search-overlay";
  overlay.className = "search-overlay";
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="search-overlay__backdrop"></div>
    <div class="search-overlay__panel" role="dialog" aria-modal="true" aria-label="Site search">
      <div class="search-overlay__input-row">
        <svg class="search-overlay__icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
          <circle cx="9" cy="9" r="5.5"></circle>
          <path d="m13.5 13.5 4 4"></path>
        </svg>
        <input
          id="search-input"
          class="search-overlay__input"
          type="text"
          placeholder="Search lessons, instructions, registers, concepts..."
          autocomplete="off"
          spellcheck="false"
        />
        <kbd class="search-overlay__esc">Esc</kbd>
      </div>
      <div id="search-results" class="search-overlay__results" hidden></div>
      <div id="search-empty" class="search-overlay__empty" hidden>
        No results for "<span id="search-empty-query"></span>"
      </div>
      <div class="search-overlay__footer">
        <span>↑↓ navigate</span>
        <span>↵ open</span>
        <span>esc close</span>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const backdrop = overlay.querySelector(".search-overlay__backdrop");
  const panel = overlay.querySelector(".search-overlay__panel");
  const input = overlay.querySelector("#search-input");
  const results = overlay.querySelector("#search-results");
  const empty = overlay.querySelector("#search-empty");
  const emptyQuery = overlay.querySelector("#search-empty-query");

  if (
    !(backdrop instanceof HTMLDivElement) ||
    !(panel instanceof HTMLDivElement) ||
    !(input instanceof HTMLInputElement) ||
    !(results instanceof HTMLDivElement) ||
    !(empty instanceof HTMLDivElement) ||
    !(emptyQuery instanceof HTMLSpanElement)
  ) {
    throw new Error("Search overlay failed to initialize.");
  }

  elements = { overlay, backdrop, panel, input, results, empty, emptyQuery };

  backdrop.addEventListener("click", () => closeSearch());

  input.addEventListener("input", () => {
    renderResults(input.value);
  });

  input.addEventListener("keydown", (event) => {
    const entries = Array.from(results.querySelectorAll<HTMLAnchorElement>(".search-result"));
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (entries.length === 0) {
        return;
      }
      selectedIndex = (selectedIndex + 1) % entries.length;
      syncSelected(entries);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (entries.length === 0) {
        return;
      }
      selectedIndex = (selectedIndex - 1 + entries.length) % entries.length;
      syncSelected(entries);
      return;
    }
    if (event.key === "Enter") {
      const selected = entries[selectedIndex];
      if (selected) {
        event.preventDefault();
        selected.click();
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeSearch();
    }
  });

  results.addEventListener("mousemove", (event) => {
    const target = (event.target as HTMLElement | null)?.closest<HTMLAnchorElement>(".search-result");
    if (!target) {
      return;
    }
    const index = Number(target.dataset.index ?? "0");
    if (!Number.isNaN(index)) {
      selectedIndex = index;
      syncSelected(Array.from(results.querySelectorAll<HTMLAnchorElement>(".search-result")));
    }
  });

  results.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement | null)?.closest<HTMLAnchorElement>(".search-result");
    if (!target) {
      return;
    }
    closeSearch(false);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && elements && elements.overlay.hidden === false) {
      event.preventDefault();
      closeSearch();
    }
  });

  return elements;
}

function syncSelected(entries: HTMLAnchorElement[]): void {
  entries.forEach((entry, index) => {
    entry.classList.toggle("is-selected", index === selectedIndex);
  });
  entries[selectedIndex]?.scrollIntoView({ block: "nearest" });
}

function renderResults(query: string): void {
  const ui = ensureOverlay();
  const trimmed = query.trim();
  if (trimmed.length < 2) {
    ui.results.hidden = true;
    ui.empty.hidden = true;
    ui.results.innerHTML = "";
    selectedIndex = 0;
    return;
  }

  const results = search(trimmed, 8);
  if (results.length === 0) {
    ui.results.hidden = true;
    ui.empty.hidden = false;
    ui.emptyQuery.textContent = trimmed;
    ui.results.innerHTML = "";
    selectedIndex = 0;
    return;
  }

  ui.empty.hidden = true;
  ui.results.hidden = false;
  selectedIndex = 0;
  ui.results.innerHTML = results
    .map(
      (result, index) => `
        <a class="search-result${index === 0 ? " is-selected" : ""}" href="${escapeHtml(result.url)}" data-index="${index}" data-category="${escapeHtml(result.category)}">
          <div class="search-result__icon">${escapeHtml(result.icon)}</div>
          <div class="search-result__body">
            <span class="search-result__title">${highlightMatch(result.title, trimmed)}</span>
            <span class="search-result__desc">${escapeHtml(result.description)}</span>
          </div>
          <div class="search-result__category">
            <span class="search-result__cat-label">${escapeHtml(result.categoryLabel)}</span>
            <svg class="search-result__arrow" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
              <path d="M5 10h10"></path>
              <path d="m11 6 4 4-4 4"></path>
            </svg>
          </div>
        </a>
      `
    )
    .join("");
}

export function closeSearch(restoreFocus = true): void {
  const ui = ensureOverlay();
  ui.overlay.hidden = true;
  ui.input.value = "";
  ui.results.innerHTML = "";
  ui.results.hidden = true;
  ui.empty.hidden = true;
  selectedIndex = 0;
  if (restoreFocus) {
    previousFocus?.focus();
  }
}

export function openSearch(): void {
  const ui = ensureOverlay();
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  ui.overlay.hidden = false;
  ui.input.focus();
  ui.input.select();
  renderResults(ui.input.value);
}
