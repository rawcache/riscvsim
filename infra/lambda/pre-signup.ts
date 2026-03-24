// @ts-nocheck
const { createHmac, timingSafeEqual } = require("node:crypto");

const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET || "";

function signPayload(encodedPayload) {
  return createHmac("sha256", TURNSTILE_SECRET).update(encodedPayload).digest("base64url");
}

function verifyTurnstileProof(proof, email) {
  if (!TURNSTILE_SECRET || typeof proof !== "string" || !proof.includes(".")) {
    return false;
  }

  const [encodedPayload, signature] = proof.split(".", 2);
  if (!encodedPayload || !signature) {
    return false;
  }

  const expectedSignature = signPayload(encodedPayload);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    return false;
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    return false;
  }

  const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!payload || payload.email !== normalizedEmail) {
    return false;
  }

  return typeof payload.exp === "number" && payload.exp > Date.now();
}

exports.handler = async (event) => {
  const email = event.request.userAttributes.email?.toLowerCase() ?? "";
  const proof = event.request.clientMetadata?.turnstileProof;

  event.response = event.response ?? {};

  if (!verifyTurnstileProof(proof, email)) {
    throw new Error("Human verification failed.");
  }

  if (email.endsWith("@gatech.edu")) {
    event.response.autoConfirmUser = false;
    event.response.autoVerifyEmail = false;
  } else {
    event.response.autoConfirmUser = true;
    event.response.autoVerifyEmail = true;
  }

  return event;
};
