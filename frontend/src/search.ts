import { SEARCH_INDEX, type SearchEntry } from "./search-index";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/=/g, "&#61;");
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/^[?]+/, "")
    .replace(/\bwhat is\b/g, "")
    .replace(/\bhow to\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function highlightMatch(text: string, query: string): string {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) {
    return escapeHtml(text);
  }
  const rawLower = text.toLowerCase();
  const queryLower = normalizedQuery.toLowerCase();
  const directIndex = rawLower.indexOf(queryLower);
  if (directIndex >= 0) {
    const before = text.slice(0, directIndex);
    const match = text.slice(directIndex, directIndex + queryLower.length);
    const after = text.slice(directIndex + queryLower.length);
    return `${escapeHtml(before)}<mark>${escapeHtml(match)}</mark>${escapeHtml(after)}`;
  }

  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    const index = rawLower.indexOf(token.toLowerCase());
    if (index >= 0) {
      const before = text.slice(0, index);
      const match = text.slice(index, index + token.length);
      const after = text.slice(index + token.length);
      return `${escapeHtml(before)}<mark>${escapeHtml(match)}</mark>${escapeHtml(after)}`;
    }
  }

  return escapeHtml(text);
}

export function search(query: string, limit = 8): SearchEntry[] {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery || normalizedQuery.length < 2) {
    return [];
  }

  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  const results = SEARCH_INDEX.map((entry) => {
    const normalizedTitle = normalize(entry.title);
    const normalizedDescription = normalize(entry.description);
    const normalizedKeywords = entry.keywords.map((keyword) => normalize(keyword)).filter(Boolean);
    let score = 0;

    if (normalizedTitle === normalizedQuery) {
      score += 100;
    }
    if (normalizedTitle.startsWith(normalizedQuery)) {
      score += 80;
    }
    if (normalizedTitle.includes(normalizedQuery)) {
      score += 60;
    }

    for (const keyword of normalizedKeywords) {
      if (keyword === normalizedQuery) {
        score += 40;
      }
      if (keyword.startsWith(normalizedQuery)) {
        score += 25;
      }
      if (keyword.includes(normalizedQuery)) {
        score += 10;
      }

      for (const token of tokens) {
        if (keyword === token) {
          score += 40;
        } else if (keyword.startsWith(token)) {
          score += 25;
        } else if (keyword.includes(token)) {
          score += 10;
        }
      }
    }

    for (const token of tokens) {
      if (normalizedDescription.includes(token)) {
        score += 5;
      }
    }

    if (
      entry.category === "instruction" &&
      (normalizedTitle.startsWith(normalizedQuery) || normalizedKeywords.some((keyword) => keyword === normalizedQuery))
    ) {
      score += 120;
    }

    if (entry.category === "instruction" && entry.id === `inst-${normalizedQuery.replace(/\s+/g, "-")}`) {
      score += 400;
    }

    if (
      entry.category === "register" &&
      (normalizedTitle.startsWith(normalizedQuery) || normalizedKeywords.some((keyword) => keyword === normalizedQuery))
    ) {
      score += 90;
    }

    return { entry, score };
  })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.entry.title.localeCompare(right.entry.title);
    })
    .slice(0, limit)
    .map((candidate) => candidate.entry);

  return results;
}
