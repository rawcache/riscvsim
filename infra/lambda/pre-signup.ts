// @ts-nocheck
exports.handler = async (event) => {
  event.response = event.response ?? {};
  event.response.autoConfirmUser = true;
  event.response.autoVerifyEmail = true;
  return event;
};
