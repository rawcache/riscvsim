import { describe, expect, it } from "vitest";

import { highlightMatch, search } from "../../src/search";
import { SEARCH_INDEX } from "../../src/search-index";

describe("search", () => {
  it("search('') returns []", () => {
    expect(search("")).toEqual([]);
  });

  it("search('a') returns []", () => {
    expect(search("a")).toEqual([]);
  });

  it("search('addi') returns entry with id 'inst-addi' first", () => {
    expect(search("addi")[0]?.id).toBe("inst-addi");
  });

  it("search('sp') returns register sp entry in top 3", () => {
    expect(search("sp", 3).some((entry) => entry.id === "reg-x2-sp")).toBe(true);
  });

  it("search('what is risc-v') returns risc-v concept entry", () => {
    expect(search("what is risc-v", 3).some((entry) => entry.id === "concept-riscv")).toBe(true);
  });

  it("search('calling convention') returns lesson 4 in top 3", () => {
    expect(search("calling convention", 3).some((entry) => entry.id === "lesson-4-functions")).toBe(true);
  });

  it("search('ece 2035') returns ece concept entry", () => {
    expect(search("ece 2035", 3).some((entry) => entry.id === "concept-ece2035")).toBe(true);
  });

  it("search('bubble sort') returns lesson 5 in top 3", () => {
    expect(search("bubble sort", 3).some((entry) => entry.id === "lesson-5-sorting")).toBe(true);
  });

  it("search('frame pointer') returns concept entry", () => {
    expect(search("frame pointer", 3).some((entry) => entry.id === "concept-frame-pointer")).toBe(true);
  });

  it("search results have url field that is non-empty", () => {
    expect(SEARCH_INDEX.every((entry) => typeof entry.url === "string" && entry.url.length > 0)).toBe(true);
  });

  it("search('xyz123notaword') returns []", () => {
    expect(search("xyz123notaword")).toEqual([]);
  });

  it("all SEARCH_INDEX entries have required fields", () => {
    for (const entry of SEARCH_INDEX) {
      expect(entry.id.length).toBeGreaterThan(0);
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(Array.isArray(entry.keywords)).toBe(true);
      expect(entry.url.length).toBeGreaterThan(0);
      expect(entry.category.length).toBeGreaterThan(0);
      expect(entry.categoryLabel.length).toBeGreaterThan(0);
      expect(entry.icon.length).toBeGreaterThan(0);
    }
  });

  it("SEARCH_INDEX has at least 150 entries", () => {
    expect(SEARCH_INDEX.length).toBeGreaterThanOrEqual(150);
  });

  it("highlightMatch wraps match in mark tags", () => {
    expect(highlightMatch("addi — Add Immediate", "addi")).toContain("<mark>addi</mark>");
  });

  it("highlightMatch returns safe HTML", () => {
    const html = highlightMatch(`<img src=x onerror="alert(1)">`, "img");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror=");
    expect(html).toContain("&lt;");
    expect(html).toContain("<mark>img</mark>");
  });
});
