// @ts-nocheck
const { randomUUID } = require("node:crypto");
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

function createProgramId() {
  return randomUUID().replace(/-/g, "");
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

  return sortPrograms((result.Items ?? []).filter((item) => item.programId !== "progress" && item.programId !== "score").map(toProgram));
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
    return response(200, { lessons: {}, totalCompleted: 0 });
  }

  try {
    return response(200, JSON.parse(result.Item.data));
  } catch {
    return response(200, { lessons: {}, totalCompleted: 0 });
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

  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        userId: caller.userId,
        programId: "progress",
        data: JSON.stringify(body),
        updatedAt: new Date().toISOString(),
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

async function handleSaveLeaderboardScore(event, caller, claims) {
  const body = normalizeLeaderboardBody(parseBody(event));
  const updatedAt = new Date().toISOString();

  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        userId: caller.userId,
        programId: "score",
        displayName: displayNameFromClaims(claims),
        totalPoints: body.totalPoints,
        weeklyPoints: body.weeklyPoints,
        weeklyStartDate: body.weeklyStartDate || currentWeekStartUtc(),
        lessonsCompleted: body.lessonsCompleted,
        challengesPassed: body.challengesPassed,
        streak: body.streak,
        badgeCount: body.badges.length,
        badges: body.badges,
        updatedAt,
      },
    })
  );

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

    if (path === "/leaderboard" || path.endsWith("/leaderboard")) {
      if (method === "GET") {
        return await handleGetLeaderboard(getQueryParam(event, "period"));
      }
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

    if (path === "/leaderboard/score" || path.endsWith("/leaderboard/score")) {
      if (method === "POST") {
        return await handleSaveLeaderboardScore(event, caller, claims);
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
