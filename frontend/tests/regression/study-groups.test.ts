import { describe, expect, it } from "vitest";

import {
  GROUP_CODE_ALPHABET,
  STUDY_GROUP_MAX_MEMBERS,
  buildStudyGroup,
  canJoinStudyGroup,
  generateStudyGroupCode,
} from "../../src/study-groups";

describe("study-groups", () => {
  it("Group code is 6 characters", () => {
    expect(generateStudyGroupCode(() => 0)).toHaveLength(6);
  });

  it("Group code contains only alphanumeric chars", () => {
    const code = generateStudyGroupCode(() => 0.5);
    expect([...code].every((character) => GROUP_CODE_ALPHABET.includes(character))).toBe(true);
  });

  it("maxMembers is 10", () => {
    expect(buildStudyGroup({ name: "GT 2035", createdBy: "user-1" }).maxMembers).toBe(STUDY_GROUP_MAX_MEMBERS);
  });

  it("Cannot join group at capacity", () => {
    const group = buildStudyGroup({
      name: "GT 2035",
      createdBy: "user-1",
      members: Array.from({ length: STUDY_GROUP_MAX_MEMBERS }, (_, index) => ({
        userId: `user-${index}`,
        displayName: `user-${index}`,
        lessonsCompleted: 0,
        challengesPassed: 0,
        totalXP: 0,
        streak: 0,
        lastActive: new Date().toISOString(),
      })),
    });

    expect(canJoinStudyGroup(group)).toBe(false);
  });
});
