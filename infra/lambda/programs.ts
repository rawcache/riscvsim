// @ts-nocheck
const { createHmac, timingSafeEqual, randomUUID, randomInt } = require("node:crypto");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
  DeleteCommand,
} = require("@aws-sdk/lib-dynamodb");

const TABLE_NAME = process.env.PROGRAMS_TABLE_NAME || "studyriscv-saved-programs";
const LIMIT_FREE = 3;
const SOURCE_MAX_LENGTH = 50_000;
const NAME_MAX_LENGTH = 60;
const GROUP_NAME_MAX_LENGTH = 40;
const STUDY_GROUP_MAX_MEMBERS = 10;
const GROUP_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PROFILE_AVATAR_MAX_LENGTH = 200_000;
const ANNOUNCEMENT_TTL_SECONDS = 24 * 60 * 60;
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET || "";
const TURNSTILE_PROOF_TTL_MS = 10 * 60 * 1000;
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
let leaderboardCache = {
  alltime: {
    expiresAt: 0,
    data: [],
  },
  weekly: {
    expiresAt: 0,
    data: [],
  },
};

function response(statusCode, body) {
  return {
    statusCode,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  };
}

function noContent() {
  return {
    statusCode: 204,
    headers: CORS_HEADERS,
  };
}

function parseBody(event) {
  if (!event.body) {
    return {};
  }

  try {
    return JSON.parse(event.body);
  } catch {
    throw new Error("INVALID_JSON");
  }
}

function getClaims(event) {
  return event.requestContext?.authorizer?.jwt?.claims ?? {};
}

function getCaller(event) {
  const claims = getClaims(event);
  const userId = typeof claims.sub === "string" ? claims.sub : "";
  const email = typeof claims.email === "string" ? claims.email.toLowerCase() : "";
  return {
    userId,
    email,
    tier: email.endsWith("@gatech.edu") ? "pro" : "free",
  };
}

function getMethod(event) {
  return event.requestContext?.http?.method ?? event.httpMethod ?? "";
}

function getProgramId(event) {
  const rawId = event.pathParameters?.programId;
  return typeof rawId === "string" && rawId.trim().length > 0 ? decodeURIComponent(rawId) : null;
}

function getPath(event) {
  return event.requestContext?.http?.path ?? event.rawPath ?? event.path ?? "";
}

function getQueryParam(event, key) {
  const value = event.queryStringParameters?.[key];
  return typeof value === "string" ? value : "";
}

function base64UrlEncode(value) {
  return Buffer.from(value).toString("base64url");
}

function base64UrlDecode(value) {
  return Buffer.from(String(value || ""), "base64url").toString("utf8");
}

function signTurnstilePayload(encodedPayload) {
  return createHmac("sha256", TURNSTILE_SECRET).update(encodedPayload).digest("base64url");
}

function createTurnstileProof(email) {
  const payload = {
    email: typeof email === "string" ? email.trim().toLowerCase() : "",
    exp: Date.now() + TURNSTILE_PROOF_TTL_MS,
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  return `${encodedPayload}.${signTurnstilePayload(encodedPayload)}`;
}

async function verifyTurnstileToken(token, remoteIp) {
  if (!TURNSTILE_SECRET) {
    throw new Error("TURNSTILE_NOT_CONFIGURED");
  }

  const params = new URLSearchParams({
    secret: TURNSTILE_SECRET,
    response: typeof token === "string" ? token.trim() : "",
  });
  if (remoteIp) {
    params.set("remoteip", remoteIp);
  }

  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  const payload = await response.json().catch(() => ({}));
  return Boolean(response.ok && payload && payload.success === true);
}

async function handleVerifyTurnstile(event) {
  const body = parseBody(event);
  const token = typeof body.token === "string" ? body.token.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!token) {
    return response(400, {
      success: false,
      message: "Human verification failed. Try again.",
    });
  }

  const verified = await verifyTurnstileToken(token, event.requestContext?.http?.sourceIp ?? "");
  if (!verified) {
    return response(403, {
      success: false,
      message: "Human verification failed. Try again.",
    });
  }

  return response(200, {
    success: true,
    proof: createTurnstileProof(email),
    expiresAt: Date.now() + TURNSTILE_PROOF_TTL_MS,
  });
}

function toProgram(item) {
  return {
    programId: item.programId,
    name: item.name,
    source: item.source,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function sortPrograms(programs) {
  return [...programs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function isSavedProgramItem(item) {
  const programId = typeof item?.programId === "string" ? item.programId : "";
  return (
    programId &&
    programId !== "progress" &&
    programId !== "score" &&
    !programId.startsWith("group#") &&
    !programId.startsWith("submission#")
  );
}

function validateName(name) {
  if (typeof name !== "string") {
    return { error: "Program name is required." };
  }

  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > NAME_MAX_LENGTH) {
    return { error: "Program name must be between 1 and 60 characters." };
  }

  return { value: trimmed };
}

function validateSource(source) {
  if (typeof source !== "string") {
    return { error: "Program source is required." };
  }

  if (source.length < 1 || source.length > SOURCE_MAX_LENGTH) {
    return { error: "Program source must be between 1 and 50000 characters." };
  }

  return { value: source };
}

function validateGroupName(name) {
  if (typeof name !== "string") {
    return { error: "Group name is required." };
  }

  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > GROUP_NAME_MAX_LENGTH) {
    return { error: "Group name must be between 1 and 40 characters." };
  }

  return { value: trimmed };
}

function usernameFromEmail(email) {
  if (typeof email !== "string" || !email.includes("@")) {
    return "anonymous";
  }
  return email.split("@")[0].trim().toLowerCase();
}

function groupPartitionKey(code) {
  return `GROUP#${code.toUpperCase()}`;
}

function groupMembershipProgramId(code) {
  return `group#${code.toUpperCase()}`;
}

function validateGroupCode(code) {
  const normalized = typeof code === "string" ? code.trim().toUpperCase() : "";
  if (!normalized || normalized.length !== 6) {
    return { error: "Group code must be 6 characters." };
  }
  if (![...normalized].every((character) => GROUP_CODE_ALPHABET.includes(character))) {
    return { error: "Group code is invalid." };
  }
  return { value: normalized };
}

function createGroupCode() {
  let code = "";
  for (let index = 0; index < 6; index += 1) {
    code += GROUP_CODE_ALPHABET[randomInt(0, GROUP_CODE_ALPHABET.length)];
  }
  return code;
}

function createProgramId() {
  return randomUUID().replace(/-/g, "");
}

function announcementProgramId(type, userId) {
  return `announcement#${type}#${userId}`;
}

async function listPrograms(userId) {
  const result = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "userId = :userId",
      ExpressionAttributeValues: {
        ":userId": userId,
      },
    })
  );

  return sortPrograms((result.Items ?? []).filter(isSavedProgramItem).map(toProgram));
}

async function readProgram(userId, programId) {
  const result = await ddb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        userId,
        programId,
      },
    })
  );

  return result.Item ? toProgram(result.Item) : null;
}

async function handleGetPrograms(caller) {
  const programs = await listPrograms(caller.userId);
  return response(200, {
    programs,
    tier: caller.tier,
    count: programs.length,
  });
}

async function handleCreateProgram(event, caller) {
  const body = parseBody(event);
  const name = validateName(body.name);
  if (name.error) {
    return response(400, { error: "VALIDATION_ERROR", message: name.error });
  }

  const source = validateSource(body.source);
  if (source.error) {
    return response(400, { error: "VALIDATION_ERROR", message: source.error });
  }

  const existingPrograms = await listPrograms(caller.userId);
  if (caller.tier === "free" && existingPrograms.length >= LIMIT_FREE) {
    return response(403, {
      error: "LIMIT_REACHED",
      message: "Free accounts can save up to 3 programs. Upgrade to Pro for unlimited saves.",
      limit: LIMIT_FREE,
    });
  }

  const timestamp = new Date().toISOString();
  const program = {
    userId: caller.userId,
    programId: createProgramId(),
    name: name.value,
    source: source.value,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: program,
    })
  );

  return response(201, toProgram(program));
}

async function handleUpdateProgram(event, caller, programId) {
  if (!programId) {
    return response(404, { error: "NOT_FOUND", message: "Program not found." });
  }

  const existingProgram = await readProgram(caller.userId, programId);
  if (!existingProgram) {
    return response(404, { error: "NOT_FOUND", message: "Program not found." });
  }

  const body = parseBody(event);
  const updates = [];
  const names = {
    "#updatedAt": "updatedAt",
  };
  const values = {
    ":updatedAt": new Date().toISOString(),
  };

  if (body.name !== undefined) {
    const name = validateName(body.name);
    if (name.error) {
      return response(400, { error: "VALIDATION_ERROR", message: name.error });
    }
    names["#name"] = "name";
    values[":name"] = name.value;
    updates.push("#name = :name");
  }

  if (body.source !== undefined) {
    const source = validateSource(body.source);
    if (source.error) {
      return response(400, { error: "VALIDATION_ERROR", message: source.error });
    }
    names["#source"] = "source";
    values[":source"] = source.value;
    updates.push("#source = :source");
  }

  if (updates.length === 0) {
    return response(400, {
      error: "VALIDATION_ERROR",
      message: "Provide a name and/or source to update.",
    });
  }

  updates.push("#updatedAt = :updatedAt");

  const result = await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: {
        userId: caller.userId,
        programId,
      },
      UpdateExpression: `SET ${updates.join(", ")}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: "ALL_NEW",
    })
  );

  return response(200, toProgram(result.Attributes));
}

async function handleDeleteProgram(caller, programId) {
  if (!programId) {
    return response(404, { error: "NOT_FOUND", message: "Program not found." });
  }

  const existingProgram = await readProgram(caller.userId, programId);
  if (!existingProgram) {
    return response(404, { error: "NOT_FOUND", message: "Program not found." });
  }

  await ddb.send(
    new DeleteCommand({
      TableName: TABLE_NAME,
      Key: {
        userId: caller.userId,
        programId,
      },
    })
  );

  return noContent();
}

async function handleGetProgress(caller) {
  const result = await ddb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        userId: caller.userId,
        programId: "progress",
      },
    })
  );

  if (!result.Item?.data) {
    return response(200, {
      lessonProgress: { lessons: {}, totalCompleted: 0 },
      checkpointProgress: {},
      problemProgress: {},
    });
  }

  try {
    const parsed = JSON.parse(result.Item.data);
    if (
      parsed &&
      typeof parsed === "object" &&
      ("lessonProgress" in parsed || "checkpointProgress" in parsed || "problemProgress" in parsed)
    ) {
      return response(200, {
        lessonProgress:
          parsed.lessonProgress && typeof parsed.lessonProgress === "object"
            ? parsed.lessonProgress
            : { lessons: {}, totalCompleted: 0 },
        checkpointProgress:
          parsed.checkpointProgress && typeof parsed.checkpointProgress === "object"
            ? parsed.checkpointProgress
            : {},
        problemProgress:
          parsed.problemProgress && typeof parsed.problemProgress === "object"
            ? parsed.problemProgress
            : {},
      });
    }
    return response(200, {
      lessonProgress: parsed,
      checkpointProgress: {},
      problemProgress: {},
    });
  } catch {
    return response(200, {
      lessonProgress: { lessons: {}, totalCompleted: 0 },
      checkpointProgress: {},
      problemProgress: {},
    });
  }
}

async function handleSaveProgress(event, caller) {
  const body = parseBody(event);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return response(400, {
      error: "VALIDATION_ERROR",
      message: "Progress payload must be an object.",
    });
  }

  let existing = {
    lessonProgress: { lessons: {}, totalCompleted: 0 },
    checkpointProgress: {},
    problemProgress: {},
  };
  const existingItem = await ddb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        userId: caller.userId,
        programId: "progress",
      },
    })
  );

  if (typeof existingItem.Item?.data === "string") {
    try {
      const parsed = JSON.parse(existingItem.Item.data);
      existing =
        parsed && typeof parsed === "object" && ("lessonProgress" in parsed || "checkpointProgress" in parsed || "problemProgress" in parsed)
          ? {
              lessonProgress:
                parsed.lessonProgress && typeof parsed.lessonProgress === "object"
                  ? parsed.lessonProgress
                  : { lessons: {}, totalCompleted: 0 },
              checkpointProgress:
                parsed.checkpointProgress && typeof parsed.checkpointProgress === "object"
                  ? parsed.checkpointProgress
                  : {},
              problemProgress:
                parsed.problemProgress && typeof parsed.problemProgress === "object"
                  ? parsed.problemProgress
                  : {},
            }
          : {
              lessonProgress: parsed && typeof parsed === "object" ? parsed : { lessons: {}, totalCompleted: 0 },
              checkpointProgress: {},
              problemProgress: {},
            };
    } catch {
      existing = {
        lessonProgress: { lessons: {}, totalCompleted: 0 },
        checkpointProgress: {},
        problemProgress: {},
      };
    }
  }

  const merged = {
    lessonProgress:
      body.lessonProgress && typeof body.lessonProgress === "object"
        ? body.lessonProgress
        : body.checkpointProgress || body.problemProgress
          ? existing.lessonProgress
          : body,
    checkpointProgress:
      body.checkpointProgress && typeof body.checkpointProgress === "object"
        ? body.checkpointProgress
        : existing.checkpointProgress,
    problemProgress:
      body.problemProgress && typeof body.problemProgress === "object"
        ? body.problemProgress
        : existing.problemProgress,
  };

  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        userId: caller.userId,
        programId: "progress",
        data: JSON.stringify(merged),
        updatedAt: new Date().toISOString(),
      },
    })
  );

  return response(200, { saved: true });
}

async function handleSaveSubmission(event, caller) {
  const body = parseBody(event);
  const problemId = typeof body?.problemId === "string" ? body.problemId.trim() : "";
  const verdict = typeof body?.verdict === "string" ? body.verdict.trim() : "";
  const stepsTaken = Number.isFinite(body?.stepsTaken) ? Math.max(0, Number(body.stepsTaken)) : 0;

  if (!problemId || !verdict) {
    return response(400, {
      error: "VALIDATION_ERROR",
      message: "problemId and verdict are required.",
    });
  }

  const submittedAt =
    typeof body?.submittedAt === "string" && body.submittedAt.trim().length > 0
      ? body.submittedAt
      : new Date().toISOString();

  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        userId: caller.userId,
        programId: `submission#${problemId}#${submittedAt}#${randomUUID()}`,
        type: "problem-submission",
        problemId,
        verdict,
        stepsTaken,
        passedCases: Number.isFinite(body?.passedCases) ? Math.max(0, Number(body.passedCases)) : 0,
        totalCases: Number.isFinite(body?.totalCases) ? Math.max(0, Number(body.totalCases)) : 0,
        failedCaseId: typeof body?.failedCaseId === "string" ? body.failedCaseId : "",
        errorMessage: typeof body?.errorMessage === "string" ? body.errorMessage : "",
        elapsedMs: Number.isFinite(body?.elapsedMs) ? Math.max(0, Number(body.elapsedMs)) : 0,
        submittedAt,
        updatedAt: submittedAt,
      },
    })
  );

  return response(200, { saved: true });
}

function displayNameFromClaims(claims) {
  if (typeof claims.name === "string" && claims.name.trim()) {
    return claims.name.trim();
  }
  if (typeof claims.preferred_username === "string" && claims.preferred_username.trim()) {
    return claims.preferred_username.trim();
  }
  if (typeof claims.email === "string" && claims.email.includes("@")) {
    return claims.email.split("@")[0];
  }
  if (typeof claims["cognito:username"] === "string" && claims["cognito:username"].trim()) {
    return claims["cognito:username"].trim();
  }
  return "anonymous";
}

function normalizeLeaderboardBody(body) {
  return {
    totalPoints: Number.isFinite(body?.totalPoints) ? Math.max(0, Number(body.totalPoints)) : 0,
    weeklyPoints: Number.isFinite(body?.weeklyPoints) ? Math.max(0, Number(body.weeklyPoints)) : 0,
    lessonsCompleted: Number.isFinite(body?.lessonsCompleted) ? Math.max(0, Number(body.lessonsCompleted)) : 0,
    challengesPassed: Number.isFinite(body?.challengesPassed) ? Math.max(0, Number(body.challengesPassed)) : 0,
    streak: Number.isFinite(body?.streak) ? Math.max(0, Number(body.streak)) : 0,
    longestStreak: Number.isFinite(body?.longestStreak) ? Math.max(0, Number(body.longestStreak)) : 0,
    weeklyStartDate: typeof body?.weeklyStartDate === "string" ? body.weeklyStartDate : "",
    badges: Array.isArray(body?.badges)
      ? body.badges
          .map((badge) => {
            if (!badge || typeof badge !== "object") {
              return null;
            }
            const id = typeof badge.id === "string" ? badge.id : "";
            const name = typeof badge.name === "string" ? badge.name : id;
            return id ? { id, name } : null;
          })
          .filter(Boolean)
      : [],
    pinnedBadgeIds: Array.isArray(body?.pinnedBadgeIds)
      ? body.pinnedBadgeIds.filter((badgeId) => typeof badgeId === "string").slice(0, 3)
      : [],
    profileAvatar:
      typeof body?.profileAvatar === "string" && body.profileAvatar.length <= PROFILE_AVATAR_MAX_LENGTH
        ? body.profileAvatar
        : "",
    profileAvatarType: body?.profileAvatarType === "preset" || body?.profileAvatarType === "upload" ? body.profileAvatarType : "",
    recentActivity: Array.isArray(body?.recentActivity)
      ? body.recentActivity
          .map((activity) => {
            if (!activity || typeof activity !== "object") {
              return null;
            }
            const type = activity.type;
            const title = typeof activity.title === "string" ? activity.title.trim() : "";
            if ((type !== "lesson" && type !== "challenge" && type !== "quiz") || !title) {
              return null;
            }
            return {
              type,
              title,
              completedAt: typeof activity.completedAt === "string" ? activity.completedAt : new Date().toISOString(),
              score: Number.isFinite(activity.score) ? Number(activity.score) : undefined,
            };
          })
          .filter(Boolean)
          .slice(0, 10)
      : [],
    weeklyChallengeCompletion:
      body?.weeklyChallengeCompletion &&
      typeof body.weeklyChallengeCompletion === "object" &&
      typeof body.weeklyChallengeCompletion.challengeId === "string"
        ? {
            challengeId: body.weeklyChallengeCompletion.challengeId,
            score: Number.isFinite(body.weeklyChallengeCompletion.score) ? Number(body.weeklyChallengeCompletion.score) : 0,
            timeSeconds: Number.isFinite(body.weeklyChallengeCompletion.timeSeconds)
              ? Number(body.weeklyChallengeCompletion.timeSeconds)
              : 0,
            weekNumber: Number.isFinite(body.weeklyChallengeCompletion.weekNumber)
              ? Number(body.weeklyChallengeCompletion.weekNumber)
              : 0,
          }
        : null,
    referredBy: typeof body?.referredBy === "string" ? body.referredBy.trim() : "",
  };
}

function currentWeekStartUtc() {
  const now = new Date();
  const utcDay = now.getUTCDay();
  const offset = utcDay === 0 ? 6 : utcDay - 1;
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - offset);
  return start.toISOString().slice(0, 10);
}

function activeWeeklyPoints(item) {
  const storedStart = typeof item.weeklyStartDate === "string" ? item.weeklyStartDate : "";
  if (storedStart !== currentWeekStartUtc()) {
    return 0;
  }
  return Number.isFinite(item.weeklyPoints) ? Number(item.weeklyPoints) : 0;
}

async function readGroupMeta(code) {
  const result = await ddb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        userId: groupPartitionKey(code),
        programId: "meta",
      },
    })
  );

  return result.Item ?? null;
}

async function materializeGroup(meta) {
  const members = Array.isArray(meta?.members) ? meta.members : [];
  const hydratedMembers = await Promise.all(
    members.map(async (member) => {
      const scoreResult = await ddb.send(
        new GetCommand({
          TableName: TABLE_NAME,
          Key: {
            userId: member.userId,
            programId: "score",
          },
        })
      );

      const scoreItem = scoreResult.Item ?? {};
      return {
        userId: member.userId,
        displayName:
          typeof scoreItem.displayName === "string" && scoreItem.displayName.trim()
            ? scoreItem.displayName.trim()
            : typeof member.displayName === "string" && member.displayName.trim()
              ? member.displayName.trim()
              : "anonymous",
        lessonsCompleted: Number.isFinite(scoreItem.lessonsCompleted) ? Number(scoreItem.lessonsCompleted) : 0,
        challengesPassed: Number.isFinite(scoreItem.challengesPassed) ? Number(scoreItem.challengesPassed) : 0,
        totalXP: Number.isFinite(scoreItem.totalPoints) ? Number(scoreItem.totalPoints) : 0,
        streak: Number.isFinite(scoreItem.streak) ? Number(scoreItem.streak) : 0,
        lastActive: typeof scoreItem.lastActiveDate === "string" && scoreItem.lastActiveDate ? scoreItem.lastActiveDate : meta.createdAt,
      };
    })
  );

  return {
    id: meta.groupId,
    name: meta.name,
    createdBy: meta.createdBy,
    members: hydratedMembers,
    createdAt: meta.createdAt,
    maxMembers: Number.isFinite(meta.maxMembers) ? Number(meta.maxMembers) : STUDY_GROUP_MAX_MEMBERS,
  };
}

async function handleGetWeeklyChallenge(event) {
  const challengeId = getQueryParam(event, "challengeId");
  const weekNumber = Number(getQueryParam(event, "weekNumber"));
  if (!challengeId || !Number.isFinite(weekNumber)) {
    return response(200, {
      challengeId,
      weekNumber: Number.isFinite(weekNumber) ? weekNumber : 0,
      startDate: new Date().toISOString(),
      endDate: new Date().toISOString(),
      totalAttempts: 0,
      totalPassed: 0,
      topScorers: [],
    });
  }

  const result = await ddb.send(
    new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: "programId = :programId",
      ExpressionAttributeValues: {
        ":programId": "score",
      },
    })
  );

  const matching = (result.Items ?? [])
    .filter(
      (item) =>
        typeof item.weeklyChallengeId === "string" &&
        item.weeklyChallengeId === challengeId &&
        Number(item.weeklyChallengeWeekNumber) === weekNumber
    )
    .map((item) => ({
      displayName: typeof item.displayName === "string" ? item.displayName : "anonymous",
      score: Number.isFinite(item.weeklyChallengeScore) ? Number(item.weeklyChallengeScore) : 0,
      timeSeconds: Number.isFinite(item.weeklyChallengeTimeSeconds) ? Number(item.weeklyChallengeTimeSeconds) : 0,
    }))
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.timeSeconds - right.timeSeconds;
    });

  const now = new Date();
  return response(200, {
    challengeId,
    weekNumber,
    startDate: now.toISOString(),
    endDate: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    totalAttempts: matching.length,
    totalPassed: matching.filter((entry) => entry.score > 0).length,
    topScorers: matching.slice(0, 10),
  });
}

async function handleCreateGroup(event, caller, claims) {
  const body = parseBody(event);
  const name = validateGroupName(body.name);
  if (name.error) {
    return response(400, { error: "VALIDATION_ERROR", message: name.error });
  }

  let code = "";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = createGroupCode();
    const existing = await readGroupMeta(candidate);
    if (!existing) {
      code = candidate;
      break;
    }
  }

  if (!code) {
    return response(500, { error: "INTERNAL_ERROR", message: "Could not create a unique group code." });
  }

  const createdAt = new Date().toISOString();
  const creator = {
    userId: caller.userId,
    displayName: displayNameFromClaims(claims),
  };

  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        userId: groupPartitionKey(code),
        programId: "meta",
        groupId: code,
        name: name.value,
        createdBy: caller.userId,
        createdAt,
        maxMembers: STUDY_GROUP_MAX_MEMBERS,
        members: [creator],
      },
    })
  );

  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        userId: caller.userId,
        programId: groupMembershipProgramId(code),
        groupId: code,
        name: name.value,
        joinedAt: createdAt,
      },
    })
  );

  return response(200, { groupId: code });
}

async function handleJoinGroup(event, caller, claims) {
  const body = parseBody(event);
  const code = validateGroupCode(body.code);
  if (code.error) {
    return response(400, { error: "VALIDATION_ERROR", message: code.error });
  }

  const meta = await readGroupMeta(code.value);
  if (!meta) {
    return response(404, { error: "NOT_FOUND", message: "Study group not found." });
  }

  const members = Array.isArray(meta.members) ? meta.members : [];
  if (members.some((member) => member.userId === caller.userId)) {
    return response(200, await materializeGroup(meta));
  }
  if (members.length >= STUDY_GROUP_MAX_MEMBERS) {
    return response(400, { error: "GROUP_FULL", message: "This study group is already full." });
  }

  const nextMembers = [...members, { userId: caller.userId, displayName: displayNameFromClaims(claims) }];
  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        ...meta,
        members: nextMembers,
      },
    })
  );
  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        userId: caller.userId,
        programId: groupMembershipProgramId(code.value),
        groupId: code.value,
        name: meta.name,
        joinedAt: new Date().toISOString(),
      },
    })
  );

  return response(200, await materializeGroup({ ...meta, members: nextMembers }));
}

async function handleGetMyGroups(caller) {
  const membershipQuery = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "userId = :userId AND begins_with(programId, :prefix)",
      ExpressionAttributeValues: {
        ":userId": caller.userId,
        ":prefix": "group#",
      },
    })
  );

  const groups = await Promise.all(
    (membershipQuery.Items ?? []).map(async (item) => {
      const meta = await readGroupMeta(item.groupId);
      return meta ? materializeGroup(meta) : null;
    })
  );

  return response(200, groups.filter(Boolean));
}

async function handleLeaveGroup(event, caller) {
  const body = parseBody(event);
  const code = validateGroupCode(body.groupId);
  if (code.error) {
    return response(400, { error: "VALIDATION_ERROR", message: code.error });
  }

  const meta = await readGroupMeta(code.value);
  if (!meta) {
    return response(404, { error: "NOT_FOUND", message: "Study group not found." });
  }

  const nextMembers = (Array.isArray(meta.members) ? meta.members : []).filter((member) => member.userId !== caller.userId);
  await ddb.send(
    new DeleteCommand({
      TableName: TABLE_NAME,
      Key: {
        userId: caller.userId,
        programId: groupMembershipProgramId(code.value),
      },
    })
  );

  if (nextMembers.length === 0) {
    await ddb.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: {
          userId: groupPartitionKey(code.value),
          programId: "meta",
        },
      })
    );
    return response(200, { left: true, deleted: true });
  }

  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        ...meta,
        members: nextMembers,
      },
    })
  );

  return response(200, { left: true });
}

async function handleGetProfile(username) {
  const normalizedUsername = typeof username === "string" ? username.trim().toLowerCase() : "";
  if (!normalizedUsername) {
    return response(404, { error: "NOT_FOUND", message: "Profile not found." });
  }

  const result = await ddb.send(
    new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: "programId = :programId AND username = :username",
      ExpressionAttributeValues: {
        ":programId": "score",
        ":username": normalizedUsername,
      },
    })
  );

  const item = result.Items?.[0];
  if (!item) {
    return response(404, { error: "NOT_FOUND", message: "Profile not found." });
  }

  const badges = Array.isArray(item.badges) ? item.badges : [];
  const pinnedBadgeIds = Array.isArray(item.pinnedBadgeIds) ? item.pinnedBadgeIds : [];
  return response(200, {
    displayName: typeof item.displayName === "string" ? item.displayName : normalizedUsername,
    username: normalizedUsername,
    joinedAt: typeof item.joinedAt === "string" ? item.joinedAt : item.updatedAt,
    lessonsCompleted: Number.isFinite(item.lessonsCompleted) ? Number(item.lessonsCompleted) : 0,
    challengesPassed: Number.isFinite(item.challengesPassed) ? Number(item.challengesPassed) : 0,
    totalXP: Number.isFinite(item.totalPoints) ? Number(item.totalPoints) : 0,
    currentStreak: Number.isFinite(item.streak) ? Number(item.streak) : 0,
    longestStreak: Number.isFinite(item.longestStreak) ? Number(item.longestStreak) : Number(item.streak) || 0,
    badges,
    pinnedBadges: badges.filter((badge) => pinnedBadgeIds.includes(badge.id)).slice(0, 3),
    recentActivity: Array.isArray(item.recentActivity) ? item.recentActivity : [],
    isTier: item.tier === "pro" ? "pro" : "free",
    avatarType: typeof item.profileAvatarType === "string" ? item.profileAvatarType : "",
    avatarValue: typeof item.profileAvatar === "string" ? item.profileAvatar : "",
  });
}

async function handleGetLeaderboard(period = "alltime") {
  const cacheKey = period === "weekly" ? "weekly" : "alltime";
  if (leaderboardCache[cacheKey].expiresAt > Date.now() && Array.isArray(leaderboardCache[cacheKey].data)) {
    return response(200, leaderboardCache[cacheKey].data);
  }

  const result = await ddb.send(
    new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: "programId = :programId",
      ExpressionAttributeValues: {
        ":programId": "score",
      },
    })
  );

  const ranked = (result.Items ?? [])
    .map((item) => ({
      userId: typeof item.userId === "string" ? item.userId : "",
      displayName: typeof item.displayName === "string" && item.displayName.trim() ? item.displayName.trim() : "anonymous",
      totalPoints: Number.isFinite(item.totalPoints) ? Number(item.totalPoints) : 0,
      weeklyPoints: activeWeeklyPoints(item),
      lessonsCompleted: Number.isFinite(item.lessonsCompleted) ? Number(item.lessonsCompleted) : 0,
      challengesPassed: Number.isFinite(item.challengesPassed) ? Number(item.challengesPassed) : 0,
      streak: Number.isFinite(item.streak) ? Number(item.streak) : 0,
      badges: Array.isArray(item.badges) ? item.badges : [],
      updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : "",
    }))
    .sort((left, right) => {
      const leftScore = period === "weekly" ? left.weeklyPoints : left.totalPoints;
      const rightScore = period === "weekly" ? right.weeklyPoints : right.totalPoints;
      if (rightScore !== leftScore) {
        return rightScore - leftScore;
      }
      return right.updatedAt.localeCompare(left.updatedAt);
    })
    .slice(0, 50)
    .map((entry, index) => ({
      rank: index + 1,
      displayName: entry.displayName,
      totalPoints: entry.totalPoints,
      weeklyPoints: entry.weeklyPoints,
      lessonsCompleted: entry.lessonsCompleted,
      challengesPassed: entry.challengesPassed,
      badges: entry.badges,
      streak: entry.streak,
    }));

  leaderboardCache[cacheKey] = {
    expiresAt: Date.now() + 60_000,
    data: ranked,
  };

  return response(200, ranked);
}

async function handleGetLeaderboardAnnouncements() {
  const result = await ddb.send(
    new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: "userId = :userId AND begins_with(programId, :prefix)",
      ExpressionAttributeValues: {
        ":userId": "announcement",
        ":prefix": "announcement#graduate#",
      },
    })
  );

  const nowSeconds = Math.floor(Date.now() / 1000);
  const announcements = (result.Items ?? [])
    .filter((item) => !Number.isFinite(item.ttl) || Number(item.ttl) > nowSeconds)
    .map((item) => ({
      type: "graduate",
      displayName: typeof item.displayName === "string" ? item.displayName : "anonymous",
      createdAt: typeof item.createdAt === "string" ? item.createdAt : "",
    }))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 1);

  return response(200, announcements);
}

async function handleSaveLeaderboardScore(event, caller, claims) {
  const body = normalizeLeaderboardBody(parseBody(event));
  const updatedAt = new Date().toISOString();
  const existing = await ddb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        userId: caller.userId,
        programId: "score",
      },
    })
  );
  const existingItem = existing.Item ?? {};

  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        userId: caller.userId,
        programId: "score",
        displayName: displayNameFromClaims(claims),
        username: usernameFromEmail(caller.email),
        tier: caller.tier,
        joinedAt: typeof existingItem.joinedAt === "string" ? existingItem.joinedAt : updatedAt,
        totalPoints: body.totalPoints,
        weeklyPoints: body.weeklyPoints,
        weeklyStartDate: body.weeklyStartDate || currentWeekStartUtc(),
        lessonsCompleted: body.lessonsCompleted,
        challengesPassed: body.challengesPassed,
        streak: body.streak,
        longestStreak: body.longestStreak,
        badgeCount: body.badges.length,
        badges: body.badges,
        pinnedBadgeIds: body.pinnedBadgeIds,
        recentActivity: body.recentActivity,
        profileAvatar: body.profileAvatar,
        profileAvatarType: body.profileAvatarType,
        referredBy: body.referredBy || existingItem.referredBy || "",
        referralBonusGranted: existingItem.referralBonusGranted === true,
        weeklyChallengeId: body.weeklyChallengeCompletion?.challengeId ?? existingItem.weeklyChallengeId ?? "",
        weeklyChallengeScore: body.weeklyChallengeCompletion?.score ?? existingItem.weeklyChallengeScore ?? 0,
        weeklyChallengeTimeSeconds: body.weeklyChallengeCompletion?.timeSeconds ?? existingItem.weeklyChallengeTimeSeconds ?? 0,
        weeklyChallengeWeekNumber: body.weeklyChallengeCompletion?.weekNumber ?? existingItem.weeklyChallengeWeekNumber ?? 0,
        updatedAt,
      },
    })
  );

  if (
    body.referredBy &&
    body.referredBy !== caller.userId &&
    body.lessonsCompleted > 0 &&
    existingItem.referralBonusGranted !== true
  ) {
    const referrerResult = await ddb.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          userId: body.referredBy,
          programId: "score",
        },
      })
    );
    const referrerItem = referrerResult.Item;
    if (referrerItem) {
      await ddb.send(
        new PutCommand({
          TableName: TABLE_NAME,
          Item: {
            ...referrerItem,
            totalPoints: (Number.isFinite(referrerItem.totalPoints) ? Number(referrerItem.totalPoints) : 0) + 25,
            weeklyPoints: activeWeeklyPoints(referrerItem) + 25,
            weeklyStartDate: currentWeekStartUtc(),
            updatedAt,
          },
        })
      );
    }

    await ddb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: {
          userId: caller.userId,
          programId: "score",
        },
        UpdateExpression: "SET referralBonusGranted = :granted",
        ExpressionAttributeValues: {
          ":granted": true,
        },
      })
    );
  }

  if (body.lessonsCompleted >= 20 && (Number.isFinite(existingItem.lessonsCompleted) ? Number(existingItem.lessonsCompleted) : 0) < 20) {
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          userId: "announcement",
          programId: announcementProgramId("graduate", caller.userId),
          type: "graduate",
          displayName: displayNameFromClaims(claims),
          createdAt: updatedAt,
          ttl: Math.floor(Date.now() / 1000) + ANNOUNCEMENT_TTL_SECONDS,
        },
      })
    );
  }

  leaderboardCache.alltime.expiresAt = 0;
  leaderboardCache.alltime.data = [];
  leaderboardCache.weekly.expiresAt = 0;
  leaderboardCache.weekly.data = [];

  return response(200, { saved: true });
}

exports.handler = async (event) => {
  try {
    const method = getMethod(event).toUpperCase();
    const path = getPath(event);
    const programId = getProgramId(event);
    const claims = getClaims(event);
    const profileUsername = event.pathParameters?.username;

    if (path === "/leaderboard" || path.endsWith("/leaderboard")) {
      if (method === "GET") {
        return await handleGetLeaderboard(getQueryParam(event, "period"));
      }
    }

    if (path === "/leaderboard/announcements" || path.endsWith("/leaderboard/announcements")) {
      if (method === "GET") {
        return await handleGetLeaderboardAnnouncements();
      }
    }

    if (path === "/leaderboard/weekly-challenge" || path.endsWith("/leaderboard/weekly-challenge")) {
      if (method === "GET") {
        return await handleGetWeeklyChallenge(event);
      }
    }

    if (path === "/auth/verify-turnstile" || path.endsWith("/auth/verify-turnstile")) {
      if (method === "POST") {
        return await handleVerifyTurnstile(event);
      }
    }

    if ((path.startsWith("/profile/") || path.includes("/profile/")) && method === "GET") {
      return await handleGetProfile(typeof profileUsername === "string" ? decodeURIComponent(profileUsername) : "");
    }

    const caller = getCaller(event);
    if (!caller.userId || !caller.email) {
      return response(401, {
        error: "UNAUTHORIZED",
        message: "Authentication required.",
      });
    }

    if (path === "/progress" || path.endsWith("/progress")) {
      if (method === "GET") {
        return await handleGetProgress(caller);
      }

      if (method === "POST") {
        return await handleSaveProgress(event, caller);
      }
    }

    if (path === "/submissions" || path.endsWith("/submissions")) {
      if (method === "POST") {
        return await handleSaveSubmission(event, caller);
      }
    }

    if (path === "/leaderboard/score" || path.endsWith("/leaderboard/score")) {
      if (method === "POST") {
        return await handleSaveLeaderboardScore(event, caller, claims);
      }
    }

    if (path === "/groups/create" || path.endsWith("/groups/create")) {
      if (method === "POST") {
        return await handleCreateGroup(event, caller, claims);
      }
    }

    if (path === "/groups/join" || path.endsWith("/groups/join")) {
      if (method === "POST") {
        return await handleJoinGroup(event, caller, claims);
      }
    }

    if (path === "/groups/mine" || path.endsWith("/groups/mine")) {
      if (method === "GET") {
        return await handleGetMyGroups(caller);
      }
    }

    if (path === "/groups/leave" || path.endsWith("/groups/leave")) {
      if (method === "DELETE") {
        return await handleLeaveGroup(event, caller);
      }
    }

    if (method === "GET" && !programId) {
      return await handleGetPrograms(caller);
    }

    if (method === "POST" && !programId) {
      return await handleCreateProgram(event, caller);
    }

    if (method === "PUT") {
      return await handleUpdateProgram(event, caller, programId);
    }

    if (method === "DELETE") {
      return await handleDeleteProgram(caller, programId);
    }

    return response(404, {
      error: "NOT_FOUND",
      message: "Route not found.",
    });
  } catch (error) {
    if ((error && error.message) === "INVALID_JSON") {
      return response(400, {
        error: "VALIDATION_ERROR",
        message: "Request body must be valid JSON.",
      });
    }

    console.error(error);
    return response(500, {
      error: "INTERNAL_ERROR",
      message: "Something went wrong.",
    });
  }
};
