function hex32(value: number | undefined): string {
  return `0x${((value ?? 0) >>> 0).toString(16).padStart(8, "0").toUpperCase()}`;
}

export type ClipEvent =
  | "landing-load"
  | "assemble-success"
  | "assemble-error"
  | "step"
  | "step-back"
  | "run-start"
  | "run-halt"
  | "run-breakpoint"
  | "reset"
  | "lesson-start"
  | "lesson-step-complete"
  | "lesson-checkpoint-pass"
  | "lesson-checkpoint-fail"
  | "lesson-complete"
  | "challenge-pass"
  | "challenge-fail"
  | "quiz-start"
  | "quiz-complete"
  | "streak-milestone"
  | "first-visit";

export interface ClipContext {
  pc?: number;
  registers?: number[];
  prevRegisters?: number[];
  spDelta?: number;
  raDelta?: boolean;
  changedReg?: number;
  changedRegValue?: number;
  branchTaken?: boolean;
  branchNotTaken?: boolean;
  destIsX0?: boolean;
  instructionType?: string;
  instructionText?: string;
  stepNumber?: number;
  totalInstructions?: number;
  errorMessage?: string;
  errorLine?: number;
  lessonTitle?: string;
  lessonNumber?: number;
  stepTitle?: string;
  attemptCount?: number;
  quizScore?: number;
  challengeScore?: number;
  maxScore?: number;
  streakDays?: number;
  isFirstVisit?: boolean;
  timeOfDay?: "morning" | "afternoon" | "evening" | "night";
  hasDataSegment?: boolean;
  recursivePatternDetected?: boolean;
}

export interface ClipLine {
  text: string;
  duration: number;
  priority: number;
}

let lastSpokenAt = 0;
let recentDismissals = 0;
let dismissalCooldownUntil = 0;
let consecutiveSteps = 0;
let lastStepAt = 0;
let userInFlow = false;
let landingLoadCounter = 0;
let landingLoadSpokenCount = 0;
let lessonCheckpointPassCounter = 0;
let stepBackCounter = 0;

function line(text: string, duration: number, priority: number): ClipLine {
  return { text, duration, priority };
}

function trimSentence(value: string): string {
  return value.replace(/[.\s]+$/g, "").trim();
}

export function recordDismissal(): void {
  recentDismissals += 1;
  if (recentDismissals >= 3) {
    dismissalCooldownUntil = Date.now() + 5 * 60 * 1000;
  }
}

export function recordSpoken(): void {
  lastSpokenAt = Date.now();
  recentDismissals = 0;
}

export function recordStep(): void {
  const now = Date.now();
  if (lastStepAt !== 0 && now - lastStepAt < 2000) {
    consecutiveSteps += 1;
  } else {
    consecutiveSteps = 1;
  }
  lastStepAt = now;
  userInFlow = consecutiveSteps >= 10;
}

export function shouldSpeak(priority: number): boolean {
  const now = Date.now();
  if (now < dismissalCooldownUntil) {
    return false;
  }
  if (now - lastSpokenAt < 8000 && priority < 8) {
    return false;
  }
  if (userInFlow && priority < 7) {
    return false;
  }
  return true;
}

function assembleErrorLine(context: ClipContext): ClipLine {
  const message = (context.errorMessage ?? "").toLowerCase();
  if (message.includes("immediate")) {
    return line("Immediate out of range. 12-bit signed max is 2047.", 5000, 9);
  }
  if (message.includes("misalign")) {
    return line("Misaligned. Word addresses must be divisible by 4.", 5000, 9);
  }
  if (message.includes("undefined")) {
    return line("Label not found. Check your spelling.", 5000, 9);
  }
  if (message.includes("register")) {
    return line("That's not a valid register name.", 5000, 9);
  }
  return line(`Assembly failed. Line ${context.errorLine ?? "?"}.`, 5000, 9);
}

function landingLoadLine(): ClipLine | null {
  landingLoadCounter = (landingLoadCounter + 1) % 5;
  if (landingLoadCounter !== 0) {
    return null;
  }
  landingLoadSpokenCount += 1;
  return landingLoadSpokenCount % 2 === 0
    ? line("Back again.", 3000, 2)
    : line("More assembly to run.", 3000, 2);
}

function lessonCheckpointPassLine(): ClipLine | null {
  const responses = ["Correct.", "That's it.", "Good."];
  const cycle = lessonCheckpointPassCounter % 10;
  lessonCheckpointPassCounter += 1;
  if (cycle >= 3) {
    return null;
  }
  return line(responses[cycle % responses.length], 2000, 3);
}

export function getClipLine(event: ClipEvent, context: ClipContext): ClipLine | null {
  switch (event) {
    case "first-visit": {
      const options = [
        "I execute instructions. That's what I do.",
        "RV32IM. 32 registers. Load-store architecture.",
        "You're looking at a RISC-V simulator.",
      ];
      return line(options[Math.floor((Date.now() / 1000) % options.length)], 4000, 3);
    }
    case "landing-load":
      return landingLoadLine();
    case "assemble-success":
      if ((context.totalInstructions ?? 0) > 20) {
        return line(`${context.totalInstructions} instructions loaded into text segment.`, 3500, 3);
      }
      if (context.hasDataSegment) {
        return line("Data segment initialized at 0x10000000.", 3500, 3);
      }
      if (context.recursivePatternDetected) {
        return line("Recursive pattern detected. Watch the stack.", 3500, 3);
      }
      return null;
    case "assemble-error":
      return assembleErrorLine(context);
    case "step":
      if (context.destIsX0) {
        return line("Writing to x0. That instruction has no effect.", 4000, 8);
      }
      if ((context.spDelta ?? 0) < 0) {
        const delta = context.spDelta ?? 0;
        if (delta === -4) {
          return line("4-byte frame allocated.", 3500, 5);
        }
        if (delta === -8) {
          return line("8-byte frame. Room for two words.", 3500, 5);
        }
        if (delta === -16) {
          return line("Standard 16-byte frame.", 3500, 5);
        }
        return line(`${Math.abs(delta)}-byte frame allocated.`, 3500, 5);
      }
      if ((context.spDelta ?? 0) > 0) {
        return line("Frame deallocated. sp restored.", 3000, 4);
      }
      if (context.raDelta && (context.spDelta ?? 0) < 0) {
        return line("ra saved to stack. Nested call ahead.", 3500, 6);
      }
      if (context.raDelta) {
        return line("ra updated. Function called.", 3500, 5);
      }
      if (context.branchTaken) {
        if (context.instructionType === "beq") {
          return line("Equal. Branch taken.", 3000, 4);
        }
        if (context.instructionType === "bne") {
          return line("Not equal. Branch taken.", 3000, 4);
        }
        if (context.instructionType === "blt") {
          return line("Less than. Branch taken.", 3000, 4);
        }
        if (context.instructionType === "bge") {
          return line("Greater or equal. Branch taken.", 3000, 4);
        }
        return line("Branch taken.", 3000, 4);
      }
      if (["lw", "lh", "lb", "lhu", "lbu"].includes(context.instructionType ?? "") && context.changedRegValue === 0) {
        return line("Loaded zero. Is that expected?", 3500, 5);
      }
      return null;
    case "step-back":
      stepBackCounter += 1;
      if (stepBackCounter === 1) {
        return line("Stepping back.", 2500, 3);
      }
      if (stepBackCounter === 5) {
        return line("That's far back.", 2500, 3);
      }
      return null;
    case "run-start":
      return null;
    case "run-halt":
      if (context.errorMessage) {
        return line(`Trap. ${trimSentence(context.errorMessage)}.`, 3500, 5);
      }
      if ((context.stepNumber ?? 0) < 10) {
        return line(`${context.stepNumber ?? 0} instructions.`, 3500, 5);
      }
      if ((context.stepNumber ?? 0) < 100) {
        return line(`${context.stepNumber ?? 0} instructions executed.`, 3500, 5);
      }
      return line(`${context.stepNumber ?? 0} instructions. That's a long program.`, 3500, 5);
    case "run-breakpoint":
      return line(`Breakpoint. PC = ${hex32(context.pc)}.`, 4000, 8);
    case "reset":
      return null;
    case "lesson-start":
      return context.lessonNumber && context.lessonTitle
        ? line(`Lesson ${context.lessonNumber}: ${context.lessonTitle}.`, 3000, 4)
        : null;
    case "lesson-step-complete":
      return null;
    case "lesson-checkpoint-pass":
      return lessonCheckpointPassLine();
    case "lesson-checkpoint-fail":
      if (context.attemptCount === 2) {
        return line("Check the register file.", 4000, 6);
      }
      if (context.attemptCount === 3) {
        return line("The hint is available.", 4000, 6);
      }
      if ((context.attemptCount ?? 0) >= 5) {
        return line("Look at the starter code comments.", 4000, 6);
      }
      return null;
    case "lesson-complete":
      if (context.lessonNumber === 20) {
        return line("All lessons complete.", 4000, 6);
      }
      return context.lessonNumber
        ? line(`Lesson ${context.lessonNumber} complete. ${Math.max(0, 20 - context.lessonNumber)} more to go.`, 4000, 6)
        : null;
    case "challenge-pass":
      if (context.maxScore !== undefined && context.challengeScore === context.maxScore) {
        return line("Perfect score.", 3500, 6);
      }
      if (context.challengeScore !== undefined && context.maxScore !== undefined) {
        return line(`${context.challengeScore}/${context.maxScore}. Challenge cleared.`, 3500, 6);
      }
      return line("Challenge cleared.", 3500, 6);
    case "challenge-fail":
      return (context.attemptCount ?? 0) >= 3 ? line("The hint is available.", 3500, 5) : null;
    case "quiz-start":
      return null;
    case "quiz-complete":
      if ((context.quizScore ?? 0) >= 90) {
        return line(`${context.quizScore}%. Clean.`, 4000, 7);
      }
      if ((context.quizScore ?? 0) >= 70) {
        return line(`${context.quizScore}%. Passed.`, 4000, 7);
      }
      return line(`${context.quizScore ?? 0}%. Review the material.`, 4000, 7);
    case "streak-milestone":
      if (context.streakDays === 3) {
        return line("3 days.", 3500, 5);
      }
      if (context.streakDays === 7) {
        return line("One week.", 3500, 5);
      }
      if (context.streakDays === 14) {
        return line("Two weeks.", 3500, 5);
      }
      if (context.streakDays === 30) {
        return line("30 days. Consistent.", 3500, 5);
      }
      return null;
    default:
      return null;
  }
}

export function __resetClipDialogueForTests(): void {
  lastSpokenAt = 0;
  recentDismissals = 0;
  dismissalCooldownUntil = 0;
  consecutiveSteps = 0;
  lastStepAt = 0;
  userInFlow = false;
  landingLoadCounter = 0;
  landingLoadSpokenCount = 0;
  lessonCheckpointPassCounter = 0;
  stepBackCounter = 0;
}
