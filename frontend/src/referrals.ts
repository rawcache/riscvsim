const REFERRAL_STORAGE_KEY = "studyriscv_referred_by";

export function captureReferralParam(search = typeof window !== "undefined" ? window.location.search : ""): string | null {
  if (typeof localStorage === "undefined") {
    return null;
  }

  const ref = new URLSearchParams(search).get("ref")?.trim() ?? "";
  if (!ref) {
    return null;
  }

  localStorage.setItem(REFERRAL_STORAGE_KEY, ref);
  return ref;
}

export function getStoredReferral(): string | null {
  if (typeof localStorage === "undefined") {
    return null;
  }
  return localStorage.getItem(REFERRAL_STORAGE_KEY);
}

export function buildReferralLink(userId: string, path = "/learn/"): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `https://studyriscv.com${normalizedPath}?ref=${encodeURIComponent(userId)}`;
}
