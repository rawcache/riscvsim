// @ts-nocheck
const { randomUUID } = require("node:crypto");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
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

  return sortPrograms((result.Items ?? []).map(toProgram));
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

exports.handler = async (event) => {
  try {
    const caller = getCaller(event);
    if (!caller.userId || !caller.email) {
      return response(401, {
        error: "UNAUTHORIZED",
        message: "Authentication required.",
      });
    }

    const method = getMethod(event).toUpperCase();
    const programId = getProgramId(event);

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
