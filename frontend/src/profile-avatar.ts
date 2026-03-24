import { loadScore, saveScore, setProfileAvatar } from "./scoring";

export type AvatarChoice =
  | {
      type: "preset";
      value: string;
    }
  | {
      type: "upload";
      value: string;
    };

export const PRESET_AVATARS = ["🐝", "🧠", "⚙️", "🦀", "📚", "💻", "🔬", "🛰️"] as const;

const PENDING_AVATAR_PREFIX = "studyriscv_pending_avatar:";

function normalizeKey(identifier: string): string {
  return identifier.trim().toLowerCase();
}

export function savePendingAvatarChoice(email: string, choice: AvatarChoice | null): void {
  if (typeof localStorage === "undefined") {
    return;
  }

  const key = `${PENDING_AVATAR_PREFIX}${normalizeKey(email)}`;
  if (!choice) {
    localStorage.removeItem(key);
    return;
  }

  localStorage.setItem(key, JSON.stringify(choice));
}

export function loadPendingAvatarChoice(email: string): AvatarChoice | null {
  if (typeof localStorage === "undefined") {
    return null;
  }

  const stored = localStorage.getItem(`${PENDING_AVATAR_PREFIX}${normalizeKey(email)}`);
  if (!stored) {
    return null;
  }

  try {
    const parsed = JSON.parse(stored) as Partial<AvatarChoice>;
    if ((parsed.type === "preset" || parsed.type === "upload") && typeof parsed.value === "string" && parsed.value.trim()) {
      return { type: parsed.type, value: parsed.value.trim() } as AvatarChoice;
    }
  } catch {
    // Ignore malformed pending avatar state.
  }

  return null;
}

export function clearPendingAvatarChoice(email: string): void {
  savePendingAvatarChoice(email, null);
}

export function applyPendingAvatarChoice(email: string): AvatarChoice | null {
  const pending = loadPendingAvatarChoice(email);
  if (!pending) {
    return null;
  }

  setProfileAvatar(pending.type, pending.value);
  clearPendingAvatarChoice(email);
  return pending;
}

export function getCurrentAvatarChoice(): AvatarChoice | null {
  const score = loadScore();
  if ((score.profileAvatarType === "preset" || score.profileAvatarType === "upload") && score.profileAvatar) {
    return {
      type: score.profileAvatarType,
      value: score.profileAvatar,
    };
  }
  return null;
}

export function clearCurrentAvatarChoice(): void {
  const score = loadScore();
  score.profileAvatar = "";
  score.profileAvatarType = undefined;
  saveScore(score);
}

export function avatarMarkup(choice: AvatarChoice | null, fallback: string): string {
  if (choice?.type === "upload") {
    return `<img class="nav-user-avatar__image" src="${choice.value}" alt="" />`;
  }
  if (choice?.type === "preset") {
    return `<span class="nav-user-avatar__emoji" aria-hidden="true">${choice.value}</span>`;
  }
  return fallback;
}
