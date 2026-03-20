// @ts-nocheck
exports.handler = async (event) => {
  const email = event.request.userAttributes.email?.toLowerCase() ?? "";

  event.response = event.response ?? {};

  if (email.endsWith("@gatech.edu")) {
    event.response.autoConfirmUser = false;
    event.response.autoVerifyEmail = false;
  } else {
    event.response.autoConfirmUser = true;
    event.response.autoVerifyEmail = true;
  }

  return event;
};
