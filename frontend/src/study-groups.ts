export interface StudyGroupMember {
  userId: string;
  displayName: string;
  lessonsCompleted: number;
  challengesPassed: number;
  totalXP: number;
  streak: number;
  lastActive: string;
}

export interface StudyGroup {
  id: string;
  name: string;
  createdBy: string;
  members: StudyGroupMember[];
  createdAt: string;
  maxMembers: number;
}

export const GROUP_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const STUDY_GROUP_MAX_MEMBERS = 10;

export function generateStudyGroupCode(random: () => number = Math.random): string {
  let code = "";
  for (let index = 0; index < 6; index += 1) {
    const nextIndex = Math.floor(Math.max(0, Math.min(0.999999, random())) * GROUP_CODE_ALPHABET.length);
    code += GROUP_CODE_ALPHABET[nextIndex] ?? GROUP_CODE_ALPHABET[0];
  }
  return code;
}

export function canJoinStudyGroup(group: StudyGroup): boolean {
  return group.members.length < group.maxMembers;
}

export function buildStudyGroup(input: Partial<StudyGroup> & Pick<StudyGroup, "name" | "createdBy">): StudyGroup {
  return {
    id: input.id ?? generateStudyGroupCode(),
    name: input.name,
    createdBy: input.createdBy,
    members: input.members ?? [],
    createdAt: input.createdAt ?? new Date().toISOString(),
    maxMembers: input.maxMembers ?? STUDY_GROUP_MAX_MEMBERS,
  };
}
