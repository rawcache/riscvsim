import { login, type UserSession } from "./auth";
import {
  AuthRequiredError,
  LimitReachedError,
  NotFoundError,
  deleteProgram,
  getPrograms,
  saveProgram,
  updateProgram,
  type SavedProgram,
} from "./programs-api";

const FREE_PROGRAM_LIMIT = 3;
const HISTORY_LIMIT = 50;
const HISTORY_STORAGE_KEY = "studyriscv_history";

type CurrentProgramSnapshot = {
  programId: string | null;
  name: string | null;
  isDirty: boolean;
};

type LoadProgramPayload = {
  source: string;
  programId: string | null;
  name: string | null;
};

type HistoryEntry = {
  source: string;
  timestamp: string;
  name: string;
};

type ProgramsUiOptions = {
  saveButton: HTMLButtonElement;
  dirtyIndicator: HTMLElement;
  savedPanel: HTMLElement;
  savedBody: HTMLElement;
  savedToggle: HTMLButtonElement;
  historyPanel: HTMLElement;
  historyBody: HTMLElement;
  historyToggle: HTMLButtonElement;
  getSource(): string;
  onLoadProgram(payload: LoadProgramPayload): void;
  onProgramPersisted(program: SavedProgram): void;
  onProgramDeleted(programId: string): void;
  onToast(message: string): void;
  onMessage(message: string): void;
};

export type ProgramsUiController = {
  setSession(session: UserSession | null): Promise<void>;
  setCurrentProgram(currentProgram: CurrentProgramSnapshot): void;
  recordHistory(source: string): void;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sortPrograms(programs: SavedProgram[]): SavedProgram[] {
  return [...programs].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function readHistoryFromStorage(): HistoryEntry[] {
  try {
    const raw = window.localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter((entry): entry is HistoryEntry => {
        return (
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as HistoryEntry).source === "string" &&
          typeof (entry as HistoryEntry).timestamp === "string" &&
          typeof (entry as HistoryEntry).name === "string"
        );
      })
      .slice(0, HISTORY_LIMIT);
  } catch {
    return [];
  }
}

function persistHistory(entries: HistoryEntry[]): void {
  try {
    window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(entries.slice(0, HISTORY_LIMIT)));
  } catch {
    // Ignore storage failures and keep history in memory only.
  }
}

function deriveHistoryName(source: string): string {
  const firstCodeLine = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("#"));

  const fallback = firstCodeLine ?? "Untitled program";
  return fallback.length > 40 ? `${fallback.slice(0, 37)}...` : fallback;
}

function formatRelativeTimestamp(timestamp: string): string {
  const value = Date.parse(timestamp);
  if (!Number.isFinite(value)) {
    return "";
  }

  const diffMs = Date.now() - value;
  const diffMinutes = Math.floor(diffMs / 60_000);
  if (diffMinutes < 1) {
    return "just now";
  }
  if (diffMinutes < 60) {
    return `${diffMinutes} minute${diffMinutes === 1 ? "" : "s"} ago`;
  }

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours} hour${diffHours === 1 ? "" : "s"} ago`;
  }
  if (diffHours < 48) {
    return "yesterday";
  }

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays} day${diffDays === 1 ? "" : "s"} ago`;
}

export function createProgramsUi(options: ProgramsUiOptions): ProgramsUiController {
  let session: UserSession | null = null;
  let currentProgram: CurrentProgramSnapshot = {
    programId: null,
    name: null,
    isDirty: false,
  };
  let programs: SavedProgram[] = [];
  let tier: "pro" | "free" = "free";
  let savedProgramsLoading = false;
  let savedProgramsError = "";
  let pendingDeleteId: string | null = null;
  let savedExpanded = true;
  let historyExpanded = true;
  let historyEntries = readHistoryFromStorage();
  let dialogOpen = false;
  let dialogMessage = "";
  let dialogName = "";
  let dialogLimitOverride: number | null = null;

  const dialogRoot = document.createElement("div");
  dialogRoot.className = "programs-modal";
  dialogRoot.hidden = true;
  document.body.appendChild(dialogRoot);

  function renderSaveButton() {
    const isLoggedIn = Boolean(session);
    options.saveButton.hidden = !isLoggedIn;
    const currentName = currentProgram.name?.trim();
    const tooltip = currentName ? `Save program: ${currentName}` : "Save program";
    options.saveButton.title = tooltip;
    options.saveButton.setAttribute("aria-label", tooltip);
    options.dirtyIndicator.hidden = !(isLoggedIn && currentProgram.programId && currentProgram.isDirty);
  }

  function renderToggle(button: HTMLButtonElement, expanded: boolean) {
    button.setAttribute("aria-expanded", String(expanded));
    button.classList.toggle("is-collapsed", !expanded);
  }

  function renderSavedPrograms() {
    options.savedPanel.hidden = !session;
    renderToggle(options.savedToggle, savedExpanded);
    options.savedBody.hidden = !savedExpanded || !session;

    if (!session || !savedExpanded) {
      return;
    }

    if (savedProgramsLoading) {
      options.savedBody.innerHTML = '<div class="programs-panel__empty">Loading saved programs…</div>';
      return;
    }

    if (savedProgramsError) {
      options.savedBody.innerHTML = `<div class="programs-panel__empty">${escapeHtml(savedProgramsError)}</div>`;
      return;
    }

    const countLine =
      tier === "pro" ? `${programs.length} saved` : `${programs.length} / ${FREE_PROGRAM_LIMIT} saved`;

    if (programs.length === 0) {
      options.savedBody.innerHTML = `
        <div class="programs-panel__count">${escapeHtml(countLine)}</div>
        <div class="programs-panel__empty">No saved programs yet.</div>
      `;
      return;
    }

    options.savedBody.innerHTML = `
      <div class="programs-panel__count">${escapeHtml(countLine)}</div>
      <div class="programs-list">
        ${programs
          .map((program) => {
            const isActive = currentProgram.programId === program.programId;
            const isConfirmingDelete = pendingDeleteId === program.programId;
            return `
              <div class="programs-list__item${isActive ? " is-active" : ""}">
                <span class="programs-list__name" title="${escapeHtml(program.name)}">${escapeHtml(program.name)}</span>
                ${
                  isConfirmingDelete
                    ? `
                      <div class="programs-list__confirm">
                        <span>Delete?</span>
                        <button class="programs-list__confirm-button" type="button" data-delete-confirm="${escapeHtml(program.programId)}">Yes</button>
                        <button class="programs-list__confirm-button programs-list__confirm-button--secondary" type="button" data-delete-cancel="${escapeHtml(program.programId)}">No</button>
                      </div>
                    `
                    : `
                      <div class="programs-list__actions">
                        <button
                          class="programs-list__icon"
                          type="button"
                          data-load-program="${escapeHtml(program.programId)}"
                          aria-label="Load saved program"
                          title="Load saved program"
                        >
                          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8">
                            <path d="M12 3v12"></path>
                            <path d="m7 10 5 5 5-5"></path>
                            <path d="M5 19h14"></path>
                          </svg>
                        </button>
                        <button
                          class="programs-list__icon"
                          type="button"
                          data-delete-program="${escapeHtml(program.programId)}"
                          aria-label="Delete saved program"
                          title="Delete saved program"
                        >
                          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8">
                            <path d="M3 6h18"></path>
                            <path d="M8 6V4h8v2"></path>
                            <path d="M6 6l1 14h10l1-14"></path>
                            <path d="M10 11v5M14 11v5"></path>
                          </svg>
                        </button>
                      </div>
                    `
                }
              </div>
            `;
          })
          .join("")}
      </div>
    `;

    for (const button of Array.from(
      options.savedBody.querySelectorAll<HTMLButtonElement>("[data-load-program]")
    )) {
      button.addEventListener("click", () => {
        const programId = button.dataset.loadProgram ?? "";
        const program = programs.find((entry) => entry.programId === programId);
        if (!program) {
          return;
        }
        options.onLoadProgram({
          source: program.source,
          programId: program.programId,
          name: program.name,
        });
      });
    }

    for (const button of Array.from(
      options.savedBody.querySelectorAll<HTMLButtonElement>("[data-delete-program]")
    )) {
      button.addEventListener("click", () => {
        pendingDeleteId = button.dataset.deleteProgram ?? null;
        renderSavedPrograms();
      });
    }

    for (const button of Array.from(
      options.savedBody.querySelectorAll<HTMLButtonElement>("[data-delete-cancel]")
    )) {
      button.addEventListener("click", () => {
        pendingDeleteId = null;
        renderSavedPrograms();
      });
    }

    for (const button of Array.from(
      options.savedBody.querySelectorAll<HTMLButtonElement>("[data-delete-confirm]")
    )) {
      button.addEventListener("click", () => {
        const programId = button.dataset.deleteConfirm ?? "";
        void handleDeleteProgram(programId);
      });
    }
  }

  function renderHistoryPanel() {
    const visible = Boolean(session?.isGtStudent);
    options.historyPanel.hidden = !visible;
    renderToggle(options.historyToggle, historyExpanded);
    options.historyBody.hidden = !historyExpanded || !visible;

    if (!visible || !historyExpanded) {
      return;
    }

    if (historyEntries.length === 0) {
      options.historyBody.innerHTML = '<div class="programs-panel__empty">No history yet.</div>';
      return;
    }

    options.historyBody.innerHTML = `
      <div class="programs-history">
        ${historyEntries
          .map((entry, index) => {
            return `
              <button class="programs-history__item" type="button" data-history-index="${index}">
                <span class="programs-history__name" title="${escapeHtml(entry.name)}">${escapeHtml(entry.name)}</span>
                <span class="programs-history__time">${escapeHtml(formatRelativeTimestamp(entry.timestamp))}</span>
              </button>
            `;
          })
          .join("")}
      </div>
      <div class="programs-history__footer">
        <button id="clear-history-btn" class="sim-button sim-button--outline programs-history__clear" type="button">Clear history</button>
      </div>
    `;

    for (const button of Array.from(
      options.historyBody.querySelectorAll<HTMLButtonElement>("[data-history-index]")
    )) {
      button.addEventListener("click", () => {
        const index = Number.parseInt(button.dataset.historyIndex ?? "-1", 10);
        const entry = historyEntries[index];
        if (!entry) {
          return;
        }
        options.onLoadProgram({
          source: entry.source,
          programId: null,
          name: null,
        });
      });
    }

    options.historyBody.querySelector<HTMLButtonElement>("#clear-history-btn")?.addEventListener("click", () => {
      if (!window.confirm("Clear local program history?")) {
        return;
      }
      historyEntries = [];
      persistHistory(historyEntries);
      renderHistoryPanel();
      options.onToast("History cleared");
    });
  }

  function renderAll() {
    renderSaveButton();
    renderSavedPrograms();
    renderHistoryPanel();
  }

  async function refreshPrograms() {
    if (!session) {
      programs = [];
      tier = "free";
      savedProgramsError = "";
      renderSavedPrograms();
      return;
    }

    savedProgramsLoading = true;
    savedProgramsError = "";
    renderSavedPrograms();

    try {
      const response = await getPrograms();
      programs = sortPrograms(response.programs);
      tier = response.tier;
      savedProgramsError = "";
    } catch (error) {
      programs = [];
      tier = session.isGtStudent ? "pro" : "free";
      if (error instanceof AuthRequiredError) {
        savedProgramsError = "Sign in to save your programs.";
      } else {
        savedProgramsError = "Couldn't load saved programs right now.";
      }
    } finally {
      savedProgramsLoading = false;
      renderSavedPrograms();
    }
  }

  function closeDialog() {
    dialogOpen = false;
    dialogRoot.hidden = true;
    dialogRoot.innerHTML = "";
    dialogMessage = "";
    dialogLimitOverride = null;
  }

  function renderDialog() {
    if (!dialogOpen) {
      closeDialog();
      return;
    }

    const effectiveLimit = dialogLimitOverride ?? FREE_PROGRAM_LIMIT;
    const limitReached = dialogLimitOverride !== null || (tier === "free" && programs.length >= FREE_PROGRAM_LIMIT);
    dialogRoot.hidden = false;
    dialogRoot.innerHTML = `
      <div class="programs-modal__backdrop"></div>
      <div class="programs-modal__card" role="dialog" aria-modal="true" aria-labelledby="saveProgramTitle">
        <div id="saveProgramTitle" class="programs-modal__title">Save program</div>
        ${
          limitReached
            ? `
              <div class="programs-modal__message">You've reached the ${effectiveLimit} program limit for free accounts.</div>
              <div class="programs-modal__message programs-modal__message--secondary">Georgia Tech students get unlimited saves with Pro.</div>
              <button type="button" class="programs-modal__link" data-dialog-upgrade>Sign in with GT email</button>
              <div class="programs-modal__actions">
                <button type="button" class="sim-button sim-button--outline" data-dialog-cancel>Cancel</button>
              </div>
            `
            : `
              <label class="programs-modal__field">
                <span class="programs-modal__label">Program name</span>
                <input
                  id="saveProgramNameInput"
                  class="programs-modal__input"
                  type="text"
                  maxlength="60"
                  placeholder="My program"
                  value="${escapeHtml(dialogName)}"
                />
              </label>
              ${dialogMessage ? `<div class="programs-modal__error">${escapeHtml(dialogMessage)}</div>` : ""}
              <div class="programs-modal__actions">
                <button type="button" class="sim-button sim-button--primary" data-dialog-save>Save</button>
                <button type="button" class="sim-button sim-button--outline" data-dialog-cancel>Cancel</button>
              </div>
            `
        }
      </div>
    `;

    dialogRoot.querySelector<HTMLElement>(".programs-modal__backdrop")?.addEventListener("click", closeDialog);
    dialogRoot.querySelector<HTMLElement>("[data-dialog-cancel]")?.addEventListener("click", closeDialog);
    dialogRoot.querySelector<HTMLElement>("[data-dialog-upgrade]")?.addEventListener("click", () => {
      closeDialog();
      void login();
    });
    dialogRoot.querySelector<HTMLElement>("[data-dialog-save]")?.addEventListener("click", () => {
      void handleCreateProgram();
    });

    const input = dialogRoot.querySelector<HTMLInputElement>("#saveProgramNameInput");
    input?.addEventListener("input", () => {
      dialogName = input.value;
      if (dialogMessage) {
        dialogMessage = "";
        renderDialog();
      }
    });
    input?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void handleCreateProgram();
      } else if (event.key === "Escape") {
        event.preventDefault();
        closeDialog();
      }
    });
    input?.focus();
    input?.select();
  }

  function openDialog() {
    dialogOpen = true;
    dialogMessage = "";
    dialogName = currentProgram.name ?? "";
    dialogLimitOverride = null;
    renderDialog();
  }

  async function handleCreateProgram() {
    if (!session) {
      closeDialog();
      options.onMessage("Sign in to save programs.");
      return;
    }

    try {
      const program = await saveProgram(dialogName, options.getSource());
      programs = sortPrograms([program, ...programs.filter((entry) => entry.programId !== program.programId)]);
      pendingDeleteId = null;
      closeDialog();
      options.onProgramPersisted(program);
      renderSavedPrograms();
      options.onToast("Saved");
    } catch (error) {
      if (error instanceof LimitReachedError) {
        dialogLimitOverride = error.limit;
        dialogMessage = "";
        renderDialog();
        return;
      }
      if (error instanceof AuthRequiredError) {
        closeDialog();
        options.onMessage("Sign in to save programs.");
        return;
      }
      dialogMessage = "Couldn't save program right now.";
      renderDialog();
    }
  }

  async function handleUpdateCurrentProgram() {
    if (!currentProgram.programId) {
      openDialog();
      return;
    }

    if (!currentProgram.name) {
      openDialog();
      return;
    }

    try {
      const program = await updateProgram(currentProgram.programId, currentProgram.name, options.getSource());
      programs = sortPrograms([program, ...programs.filter((entry) => entry.programId !== program.programId)]);
      pendingDeleteId = null;
      options.onProgramPersisted(program);
      renderSavedPrograms();
      options.onToast("Saved");
    } catch (error) {
      if (error instanceof AuthRequiredError) {
        options.onMessage("Sign in to save programs.");
        return;
      }
      if (error instanceof NotFoundError) {
        options.onProgramDeleted(currentProgram.programId);
        await refreshPrograms();
        options.onMessage("That saved program no longer exists.");
        return;
      }
      options.onMessage("Couldn't save program right now.");
    }
  }

  async function handleDeleteProgram(programId: string) {
    try {
      await deleteProgram(programId);
      programs = programs.filter((entry) => entry.programId !== programId);
      pendingDeleteId = null;
      options.onProgramDeleted(programId);
      renderSavedPrograms();
      options.onToast("Program deleted");
    } catch (error) {
      pendingDeleteId = null;
      renderSavedPrograms();
      if (error instanceof AuthRequiredError) {
        options.onMessage("Sign in to manage saved programs.");
        return;
      }
      if (error instanceof NotFoundError) {
        options.onProgramDeleted(programId);
        await refreshPrograms();
        options.onMessage("That saved program no longer exists.");
        return;
      }
      options.onMessage("Couldn't delete program right now.");
    }
  }

  options.saveButton.addEventListener("click", () => {
    if (!session) {
      return;
    }

    if (currentProgram.programId) {
      void handleUpdateCurrentProgram();
      return;
    }

    openDialog();
  });

  options.savedToggle.addEventListener("click", () => {
    savedExpanded = !savedExpanded;
    renderSavedPrograms();
  });

  options.historyToggle.addEventListener("click", () => {
    historyExpanded = !historyExpanded;
    renderHistoryPanel();
  });

  return {
    async setSession(nextSession: UserSession | null) {
      session = nextSession;
      pendingDeleteId = null;
      dialogLimitOverride = null;
      savedExpanded = Boolean(session);
      historyExpanded = Boolean(session?.isGtStudent);
      if (!session) {
        closeDialog();
      }
      historyEntries = readHistoryFromStorage();
      await refreshPrograms();
      renderAll();
    },
    setCurrentProgram(nextCurrentProgram: CurrentProgramSnapshot) {
      currentProgram = { ...nextCurrentProgram };
      renderAll();
    },
    recordHistory(source: string) {
      if (!session?.isGtStudent || !source.trim()) {
        return;
      }

      const nextEntry: HistoryEntry = {
        source,
        timestamp: new Date().toISOString(),
        name: deriveHistoryName(source),
      };

      historyEntries = [nextEntry, ...historyEntries].slice(0, HISTORY_LIMIT);
      persistHistory(historyEntries);
      renderHistoryPanel();
    },
  };
}
