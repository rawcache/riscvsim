// @ts-nocheck
/** @param {any} event */
exports.handler = async (event) => {
  const email = String(event?.request?.userAttributes?.email ?? "").toLowerCase();
  if (!email.endsWith("@gatech.edu")) {
    throw new Error("Only @gatech.edu email addresses are accepted.");
  }

  event.response = event.response ?? {};
  event.response.autoConfirmUser = true;
  event.response.autoVerifyEmail = true;
  return event;
};
