import { AUTH_CONFIG } from "./auth-config";
import { storeSessionTokens } from "./auth";
import type { AuthConfig, UserSession } from "./auth";
import { PRESET_AVATARS, savePendingAvatarChoice } from "./profile-avatar";
const faviconChipUrl = new URL("../favicon-chip.svg", import.meta.url).href;

type Mode = "sign-in" | "sign-up" | "confirm-sign-up" | "forgot-password" | "reset-password";

type ModalState = {
  mode: Mode;
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  confirmationCode: string;
  rememberMe: boolean;
  info: string;
  error: string;
  loading: boolean;
  allowClose: boolean;
  config: AuthConfig;
  avatarType: "" | "preset" | "upload";
  avatarValue: string;
  turnstileToken: string;
  turnstileProof: string;
  humanVerified: boolean;
  turnstileError: string;
};

type ShowOptions = {
  config?: AuthConfig;
  allowClose?: boolean;
  initialMode?: Extract<Mode, "sign-in" | "sign-up">;
};

type CognitoResponse = {
  AuthenticationResult?: {
    AccessToken?: string;
    IdToken?: string;
    RefreshToken?: string;
    ExpiresIn?: number;
  };
  UserConfirmed?: boolean;
  message?: string;
  __type?: string;
};

type TurnstileVerificationResponse = {
  success?: boolean;
  proof?: string;
  expiresAt?: number;
  message?: string;
};

type TurnstileGlobal = {
  render: (
    container: Element | string,
    options: {
      sitekey: string;
      theme?: "light" | "dark" | "auto";
      callback?: (token: string) => void;
      "expired-callback"?: () => void;
      "error-callback"?: () => void;
    }
  ) => string;
  remove?: (widgetId: string) => void;
  reset?: (widgetId?: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileGlobal;
  }
}

const COGNITO_ENDPOINT = "https://cognito-idp.us-east-1.amazonaws.com/";
const EVENT_NAME = "studyriscv-auth-changed";

let overlayEl: HTMLElement | null = null;
let state: ModalState = {
  mode: "sign-in",
  firstName: "",
  lastName: "",
  email: "",
  password: "",
  confirmationCode: "",
  rememberMe: true,
  info: "",
  error: "",
  loading: false,
  allowClose: false,
  config: AUTH_CONFIG,
  avatarType: "",
  avatarValue: "",
  turnstileToken: "",
  turnstileProof: "",
  humanVerified: false,
  turnstileError: "",
};

let turnstileScriptPromise: Promise<void> | null = null;
let turnstileWidgetId: string | null = null;

function requiresHumanVerification(mode: Mode): boolean {
  return mode === "sign-in" || mode === "sign-up" || mode === "confirm-sign-up" || mode === "forgot-password" || mode === "reset-password";
}

function turnstileContainerMarkup(): string {
  if (!requiresHumanVerification(state.mode) || !state.config.turnstileSiteKey) {
    return "";
  }

  return `
    <div class="auth-modal__field auth-modal__field--turnstile">
      <span class="auth-modal__label">Human check</span>
      ${state.humanVerified ? "" : '<div class="auth-modal__turnstile-shell"><div class="auth-modal__turnstile" id="auth-turnstile"></div></div>'}
      ${
        state.humanVerified
          ? '<div class="auth-modal__turnstile-status is-success">Verification complete.</div>'
          : state.turnstileError
            ? `<div class="auth-modal__turnstile-status is-error">${escapeHtml(state.turnstileError)}</div>`
            : '<div class="auth-modal__turnstile-status">Complete the human check once to continue.</div>'
      }
    </div>
  `;
}

function resetHumanVerification(options: { keepError?: boolean } = {}): void {
  state = {
    ...state,
    turnstileToken: "",
    turnstileProof: "",
    humanVerified: false,
    turnstileError: options.keepError ? state.turnstileError : "",
  };
  if (turnstileWidgetId && typeof window !== "undefined" && window.turnstile?.reset) {
    window.turnstile.reset(turnstileWidgetId);
  }
}

function handleDocumentKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && overlayEl && state.allowClose) {
    close();
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function cleanErrorMessage(message: string): string {
  if (!message) {
    return "Something went wrong. Try again.";
  }
  if (message.includes("PLACEHOLDER")) {
    return "Authentication is not configured for this deployment. Add the Cognito Vite env vars and rebuild the frontend.";
  }
  if (message.includes("User pool client") && message.includes("does not exist")) {
    return "Authentication is misconfigured for this deployment. The Cognito app client ID is missing or invalid.";
  }
  if (message.includes("NetworkError") || message.includes("Failed to fetch")) {
    return "Couldn't reach Cognito. Check your connection and try again.";
  }
  if (message.toLowerCase().includes("human verification")) {
    return "Human verification failed. Try again.";
  }
  if (message.includes("Turnstile")) {
    return "Human verification is unavailable right now.";
  }
  if (message === "Incorrect username or password.") {
    return message;
  }
  if (message === "An account with the given email already exists.") {
    return message;
  }
  if (message === "User does not exist.") {
    return "No account found with that email.";
  }
  if (message === "Invalid verification code provided, please try again.") {
    return "Incorrect code, try again.";
  }
  if (message.includes("already exists")) {
    return "An account with the given email already exists.";
  }
  if (message.includes("Password not long enough")) {
    return "Password must be at least 8 characters.";
  }
  if (message.includes("password")) {
    return "Password does not meet the requirements.";
  }
  return "Something went wrong. Try again.";
}

function hasPlaceholderConfig(config: AuthConfig): boolean {
  return (
    config.clientId.includes("PLACEHOLDER") ||
    config.userPoolId.includes("PLACEHOLDER") ||
    config.hostedUiDomain.includes("PLACEHOLDER")
  );
}

function configErrorMessage(config: AuthConfig): string {
  if (!hasPlaceholderConfig(config)) {
    if (!config.turnstileSiteKey.trim()) {
      return "Human verification is not configured for this deployment. Add VITE_TURNSTILE_SITE_KEY and rebuild the frontend.";
    }
    return "";
  }
  return "This page was built without Cognito config. If you're on localhost, stop and restart `npm run dev`. If you're on Amplify, set VITE_COGNITO_USER_POOL_ID, VITE_COGNITO_CLIENT_ID, VITE_COGNITO_DOMAIN, and VITE_TURNSTILE_SITE_KEY, then redeploy.";
}

async function cognitoRequest(target: string, body: Record<string, unknown>): Promise<CognitoResponse> {
  const response = await fetch(COGNITO_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": `AWSCognitoIdentityProviderService.${target}`,
    },
    body: JSON.stringify(body),
  });

  const payload = (await response.json().catch(() => ({}))) as CognitoResponse;
  if (!response.ok) {
    throw new Error(cleanErrorMessage(payload.message ?? "Something went wrong. Try again."));
  }
  return payload;
}

function authApiUrl(config: AuthConfig, path: string): string {
  return `${config.apiEndpoint.replace(/\/+$/g, "")}${path}`;
}

function hasTurnstileConfig(config: AuthConfig): boolean {
  return Boolean(config.turnstileSiteKey.trim());
}

function loadTurnstileScript(): Promise<void> {
  if (typeof document === "undefined") {
    return Promise.resolve();
  }
  if (window.turnstile) {
    return Promise.resolve();
  }
  if (turnstileScriptPromise) {
    return turnstileScriptPromise;
  }

  turnstileScriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-turnstile-script="true"]');
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Unable to load Cloudflare Turnstile.")), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.defer = true;
    script.dataset.turnstileScript = "true";
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener("error", () => reject(new Error("Unable to load Cloudflare Turnstile.")), { once: true });
    document.head.appendChild(script);
  });

  return turnstileScriptPromise;
}

async function verifyTurnstileToken(token: string): Promise<void> {
  const email = state.email.trim().toLowerCase();
  const response = await fetch(authApiUrl(state.config, "/auth/verify-turnstile"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      token,
      email,
      source: "web",
    }),
  });

  const payload = (await response.json().catch(() => ({}))) as TurnstileVerificationResponse;
  if (!response.ok || !payload.success || !payload.proof) {
    throw new Error(payload.message || "Human verification failed. Try again.");
  }

  state = {
    ...state,
    turnstileToken: token,
    turnstileProof: payload.proof,
    humanVerified: true,
    turnstileError: "",
  };
}

function mountTurnstileWidget(): void {
  if (typeof document === "undefined" || !overlayEl || !hasTurnstileConfig(state.config) || !requiresHumanVerification(state.mode) || state.humanVerified) {
    return;
  }

  const container = overlayEl.querySelector<HTMLElement>("#auth-turnstile");
  if (!container) {
    return;
  }

  void loadTurnstileScript()
    .then(() => {
      if (!overlayEl || !overlayEl.contains(container) || !window.turnstile) {
        return;
      }
      container.innerHTML = "";
      turnstileWidgetId = window.turnstile.render(container, {
        sitekey: state.config.turnstileSiteKey,
        theme: document.documentElement.dataset.theme === "dark" ? "dark" : "light",
        callback: (token: string) => {
          state = {
            ...state,
            turnstileError: "",
            humanVerified: false,
            turnstileProof: "",
            turnstileToken: token,
          };
          void verifyTurnstileToken(token)
            .then(() => {
              render();
            })
            .catch((error) => {
              state = {
                ...state,
                humanVerified: false,
                turnstileProof: "",
                turnstileToken: "",
                turnstileError: cleanErrorMessage((error as Error).message),
              };
              render();
            });
        },
        "expired-callback": () => {
          resetHumanVerification({ keepError: false });
          render();
        },
        "error-callback": () => {
          state = {
            ...state,
            humanVerified: false,
            turnstileProof: "",
            turnstileToken: "",
            turnstileError: "Human verification failed. Try again.",
          };
          render();
        },
      });
    })
    .catch((error) => {
      state = {
        ...state,
        turnstileError: cleanErrorMessage((error as Error).message),
      };
      render();
    });
}

function dispatchAuthChange(session: UserSession | null): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(new CustomEvent<UserSession | null>(EVENT_NAME, { detail: session }));
}

function titleForMode(mode: Mode): string {
  switch (mode) {
    case "sign-up":
      return "Create your account";
    case "confirm-sign-up":
      return "Confirm your email";
    case "forgot-password":
      return "Reset your password";
    case "reset-password":
      return "Choose a new password";
    default:
      return "Sign in to continue";
  }
}

function renderFields(): string {
  if (state.mode === "sign-in" || state.mode === "sign-up" || state.mode === "forgot-password") {
    return `
      ${
        state.mode === "sign-up"
          ? `<div class="auth-modal__field-row">
              <label class="auth-modal__field">
                <span class="auth-modal__label">First name</span>
                <input data-auth-input="firstName" class="auth-modal__input" type="text" value="${escapeHtml(
                  state.firstName
                )}" autocomplete="given-name" />
              </label>
              <label class="auth-modal__field">
                <span class="auth-modal__label">Last name</span>
                <input data-auth-input="lastName" class="auth-modal__input" type="text" value="${escapeHtml(
                  state.lastName
                )}" autocomplete="family-name" />
              </label>
            </div>`
          : ""
      }
      <label class="auth-modal__field">
        <span class="auth-modal__label">Email</span>
        <input data-auth-input="email" class="auth-modal__input" type="email" value="${escapeHtml(state.email)}" autocomplete="email" />
      </label>
      ${
        state.mode === "forgot-password"
          ? ""
          : `<label class="auth-modal__field">
              <span class="auth-modal__label">Password</span>
              <input data-auth-input="password" class="auth-modal__input" type="password" value="${escapeHtml(
                state.password
              )}" autocomplete="${state.mode === "sign-up" ? "new-password" : "current-password"}" />
            </label>`
      }
      ${
        state.mode === "sign-in"
          ? `<label class="auth-modal__checkbox">
              <input data-auth-input="rememberMe" type="checkbox" ${state.rememberMe ? "checked" : ""} />
              <span>Remember me</span>
            </label>`
          : ""
      }
      ${
        state.mode === "sign-up"
          ? `<div class="auth-modal__avatar-section">
              <div class="auth-modal__label">Profile picture</div>
              <div class="auth-modal__avatar-presets">
                ${PRESET_AVATARS.map(
                  (avatar) => `
                    <button
                      class="auth-modal__avatar-option${state.avatarType === "preset" && state.avatarValue === avatar ? " is-selected" : ""}"
                      type="button"
                      data-auth-avatar-preset="${escapeHtml(avatar)}"
                    >${escapeHtml(avatar)}</button>
                  `
                ).join("")}
              </div>
              <label class="auth-modal__upload">
                <span>Or upload a picture</span>
                <span class="auth-modal__upload-button">${state.avatarType === "upload" && state.avatarValue ? "Choose a different image" : "Choose an image"}</span>
                <input data-auth-avatar-upload type="file" accept="image/*" />
              </label>
              ${
                state.avatarType === "upload" && state.avatarValue
                  ? '<div class="auth-modal__avatar-preview"><img class="auth-modal__avatar-preview-image" src="' +
                    escapeHtml(state.avatarValue) +
                    '" alt="" /></div>'
                  : ""
              }
            </div>`
          : ""
      }
    `;
  }

  return `
    <label class="auth-modal__field">
      <span class="auth-modal__label">Code</span>
      <input data-auth-input="confirmationCode" class="auth-modal__input" type="text" inputmode="numeric" maxlength="6" value="${escapeHtml(
        state.confirmationCode
      )}" autocomplete="one-time-code" />
    </label>
    ${
      state.mode === "reset-password"
        ? `<label class="auth-modal__field">
            <span class="auth-modal__label">New password</span>
            <input data-auth-input="password" class="auth-modal__input" type="password" value="${escapeHtml(
              state.password
            )}" autocomplete="new-password" />
          </label>`
        : ""
    }
  `;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("Could not read image."));
      }
    };
    reader.onerror = () => reject(new Error("Could not read image."));
    reader.readAsDataURL(file);
  });
}

function actionLabel(): string {
  if (state.loading) {
    return "Working…";
  }
  switch (state.mode) {
    case "sign-up":
      return "Create account";
    case "confirm-sign-up":
      return "Confirm code";
    case "forgot-password":
      return "Send reset code";
    case "reset-password":
      return "Reset password";
    default:
      return "Sign in";
  }
}

function secondaryActions(): string {
  if (state.mode === "sign-in") {
    return `
      <button class="auth-modal__text-button" type="button" data-auth-action="forgot-password">Forgot password?</button>
      <button class="auth-modal__text-button" type="button" data-auth-action="go-sign-up">Don't have an account? Sign up</button>
    `;
  }
  if (state.mode === "sign-up") {
    return `<button class="auth-modal__text-button" type="button" data-auth-action="go-sign-in">Already have an account? Sign in</button>`;
  }
  if (state.mode === "confirm-sign-up") {
    return `<button class="auth-modal__text-button" type="button" data-auth-action="resend-code">Resend code</button>`;
  }
  if (state.mode === "forgot-password") {
    return `<button class="auth-modal__text-button" type="button" data-auth-action="go-sign-in">Back to sign in</button>`;
  }
  return `<button class="auth-modal__text-button" type="button" data-auth-action="go-sign-in">Back to sign in</button>`;
}

function infoLine(): string {
  if (state.mode === "confirm-sign-up") {
    return escapeHtml(state.info || `We sent a code to ${state.email}`);
  }
  if (state.info) {
    return escapeHtml(state.info);
  }
  return "";
}

function validateState(): string {
  const email = state.email.trim();
  if ((state.mode === "sign-in" || state.mode === "sign-up" || state.mode === "forgot-password") && !email) {
    return "Enter your email.";
  }
  if (state.mode === "sign-up") {
    if (!state.firstName.trim()) {
      return "Enter your first name.";
    }
    if (!state.lastName.trim()) {
      return "Enter your last name.";
    }
  }
  if ((state.mode === "sign-in" || state.mode === "sign-up") && !state.password) {
    return "Enter your password.";
  }
  if (state.mode === "confirm-sign-up" && !state.confirmationCode.trim()) {
    return "Enter the code from your email.";
  }
  if (state.mode === "reset-password") {
    if (!state.confirmationCode.trim()) {
      return "Enter the reset code.";
    }
    if (!state.password) {
      return "Enter a new password.";
    }
  }
  if (requiresHumanVerification(state.mode) && !state.humanVerified) {
    return state.turnstileError || "Complete the human check to continue.";
  }
  return "";
}

function render(): void {
  if (!overlayEl) {
    return;
  }

  const configError = configErrorMessage(state.config);
  const submitDisabled =
    state.loading ||
    Boolean(configError) ||
    (requiresHumanVerification(state.mode) && !state.humanVerified);

  overlayEl.innerHTML = `
    <div class="auth-modal__backdrop"></div>
    <div class="auth-modal__card" role="dialog" aria-modal="true" aria-labelledby="authModalTitle">
      ${
        state.allowClose
          ? '<button class="auth-modal__close" type="button" data-auth-action="close" aria-label="Close auth dialog">×</button>'
          : ""
      }
      <div class="auth-modal__brand-lockup">
        <img class="auth-modal__logo" src="${escapeHtml(faviconChipUrl)}" alt="" />
        <div class="auth-modal__brand-stack">
          <div class="auth-modal__brand">StudyRISC-V</div>
          <div id="authModalTitle" class="auth-modal__subhead">${escapeHtml(titleForMode(state.mode))}</div>
        </div>
      </div>
      <form class="auth-modal__form" data-auth-action="submit">
        ${renderFields()}
        ${turnstileContainerMarkup()}
        ${infoLine() ? `<div class="auth-modal__info">${infoLine()}</div>` : ""}
        ${configError ? `<div class="auth-modal__error">${escapeHtml(configError)}</div>` : ""}
        ${state.error ? `<div class="auth-modal__error">${escapeHtml(state.error)}</div>` : ""}
        <button class="auth-modal__primary" type="submit" ${submitDisabled ? "disabled" : ""}>
          ${state.loading ? '<span class="auth-modal__spinner" aria-hidden="true"></span>' : ""}
          <span>${escapeHtml(actionLabel())}</span>
        </button>
      </form>
      <div class="auth-modal__actions">
        ${secondaryActions()}
      </div>
    </div>
  `;

  overlayEl.querySelectorAll<HTMLInputElement>("[data-auth-input]").forEach((input) => {
    input.addEventListener("input", (event) => {
      const target = event.currentTarget as HTMLInputElement;
      const key = target.dataset.authInput as
        | "firstName"
        | "lastName"
        | "email"
        | "password"
        | "confirmationCode"
        | "rememberMe";
      const nextValue = key === "rememberMe" ? target.checked : target.value;
      const emailChanged = key === "email" && target.value.trim().toLowerCase() !== state.email.trim().toLowerCase();
      state = {
        ...state,
        [key]: nextValue,
        error: "",
      };
      if (emailChanged) {
        resetHumanVerification();
      }
    });
  });

  overlayEl.querySelectorAll<HTMLButtonElement>("[data-auth-avatar-preset]").forEach((button) => {
    button.addEventListener("click", () => {
      state = {
        ...state,
        avatarType: "preset",
        avatarValue: button.dataset.authAvatarPreset ?? "",
      };
      render();
    });
  });

  overlayEl.querySelector<HTMLInputElement>("[data-auth-avatar-upload]")?.addEventListener("change", (event) => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) {
      return;
    }
    void readFileAsDataUrl(file)
      .then((dataUrl) => {
        state = {
          ...state,
          avatarType: "upload",
          avatarValue: dataUrl,
        };
        render();
      })
      .catch((error) => {
        state = {
          ...state,
          error: cleanErrorMessage((error as Error).message),
        };
        render();
      });
  });

  overlayEl.querySelector("form[data-auth-action='submit']")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void submit();
  });

  overlayEl.querySelectorAll<HTMLElement>("[data-auth-action]").forEach((element) => {
    const action = element.dataset.authAction;
    if (!action || action === "submit") {
      return;
    }
    element.addEventListener("click", (event) => {
      event.preventDefault();
      void handleAction(action);
    });
  });

  overlayEl.querySelector(".auth-modal__backdrop")?.addEventListener("click", () => {
    if (state.allowClose) {
      close();
    }
  });

  mountTurnstileWidget();
}

function ensureOverlay(): HTMLElement {
  if (overlayEl) {
    return overlayEl;
  }

  overlayEl = document.createElement("div");
  overlayEl.className = "auth-modal";
  document.body.appendChild(overlayEl);
  document.body.classList.add("auth-modal-open");
  document.addEventListener("keydown", handleDocumentKeydown);
  if (hasTurnstileConfig(state.config)) {
    void loadTurnstileScript().catch(() => {
      state = {
        ...state,
        turnstileError: "Human verification is unavailable right now.",
      };
      render();
    });
  }
  requestAnimationFrame(() => {
    overlayEl?.classList.add("is-visible");
  });
  return overlayEl;
}

function close(): void {
  if (!overlayEl) {
    return;
  }

  overlayEl.remove();
  overlayEl = null;
  turnstileWidgetId = null;
  document.body.classList.remove("auth-modal-open");
  document.removeEventListener("keydown", handleDocumentKeydown);
}

async function signIn(): Promise<void> {
  const payload = await cognitoRequest("InitiateAuth", {
    AuthFlow: "USER_PASSWORD_AUTH",
    ClientId: state.config.clientId,
    AuthParameters: {
      USERNAME: state.email.trim(),
      PASSWORD: state.password,
    },
  });

  const result = payload.AuthenticationResult;
  if (!result?.IdToken || !result.AccessToken || typeof result.ExpiresIn !== "number") {
    throw new Error("Unable to start a session. Try again.");
  }

  const session = storeSessionTokens({
    idToken: result.IdToken,
    accessToken: result.AccessToken,
    refreshToken: result.RefreshToken,
    expiresIn: result.ExpiresIn,
    rememberMe: state.rememberMe,
  });

  if (!session) {
    throw new Error("Unable to start a session. Try again.");
  }

  dispatchAuthChange(session);
  close();
}

async function signUp(): Promise<void> {
  if (state.avatarType && state.avatarValue) {
    savePendingAvatarChoice(state.email.trim(), {
      type: state.avatarType,
      value: state.avatarValue,
    });
  }

  const payload = await cognitoRequest("SignUp", {
    ClientId: state.config.clientId,
    Username: state.email.trim(),
    Password: state.password,
    UserAttributes: [
      { Name: "email", Value: state.email.trim() },
      { Name: "given_name", Value: state.firstName.trim() },
      { Name: "family_name", Value: state.lastName.trim() },
      { Name: "name", Value: `${state.firstName.trim()} ${state.lastName.trim()}`.trim() },
    ],
    ClientMetadata: {
      turnstileProof: state.turnstileProof,
    },
  });

  if (payload.UserConfirmed) {
    await signIn();
    return;
  }

  state = {
    ...state,
    mode: "confirm-sign-up",
    confirmationCode: "",
    info: "",
    error: "",
    loading: false,
  };
  render();
}

async function confirmSignUp(): Promise<void> {
  await cognitoRequest("ConfirmSignUp", {
    ClientId: state.config.clientId,
    Username: state.email.trim(),
    ConfirmationCode: state.confirmationCode.trim(),
  });

  state = {
    ...state,
    mode: "sign-in",
    password: "",
    confirmationCode: "",
    info: "Email confirmed. Sign in to continue.",
    error: "",
    loading: false,
  };
  render();
}

async function requestPasswordReset(): Promise<void> {
  await cognitoRequest("ForgotPassword", {
    ClientId: state.config.clientId,
    Username: state.email.trim(),
  });

  state = {
    ...state,
    mode: "reset-password",
    confirmationCode: "",
    password: "",
    info: `We sent a code to ${state.email.trim()}`,
    error: "",
    loading: false,
  };
  render();
}

async function confirmPasswordReset(): Promise<void> {
  await cognitoRequest("ConfirmForgotPassword", {
    ClientId: state.config.clientId,
    Username: state.email.trim(),
    ConfirmationCode: state.confirmationCode.trim(),
    Password: state.password,
  });

  state = {
    ...state,
    mode: "sign-in",
    confirmationCode: "",
    password: "",
    info: "Password updated. Sign in with your new password.",
    error: "",
    loading: false,
  };
  render();
}

async function resendConfirmationCode(): Promise<void> {
  await cognitoRequest("ResendConfirmationCode", {
    ClientId: state.config.clientId,
    Username: state.email.trim(),
  });

  state = {
    ...state,
    info: `We sent a new code to ${state.email.trim()}`,
    error: "",
    loading: false,
  };
  render();
}

async function submit(): Promise<void> {
  const configError = configErrorMessage(state.config);
  if (configError) {
    state = { ...state, loading: false, error: configError };
    render();
    return;
  }

  const validationError = validateState();
  if (validationError) {
    state = { ...state, loading: false, error: validationError };
    render();
    return;
  }

  state = { ...state, loading: true, error: "" };
  render();

  try {
    switch (state.mode) {
      case "sign-up":
        await signUp();
        return;
      case "confirm-sign-up":
        await confirmSignUp();
        return;
      case "forgot-password":
        await requestPasswordReset();
        return;
      case "reset-password":
        await confirmPasswordReset();
        return;
      default:
        await signIn();
    }
  } catch (error) {
    state = {
      ...state,
      loading: false,
      error: cleanErrorMessage((error as Error).message),
    };
    render();
  }
}

async function handleAction(action: string): Promise<void> {
  switch (action) {
    case "close":
      if (state.allowClose) {
        close();
      }
      return;
    case "forgot-password":
      resetHumanVerification();
      state = {
        ...state,
        mode: "forgot-password",
        password: "",
        confirmationCode: "",
        error: "",
        info: "",
      };
      render();
      return;
    case "go-sign-up":
      resetHumanVerification();
      state = {
        ...state,
        mode: "sign-up",
        password: "",
        confirmationCode: "",
        error: "",
        info: "",
      };
      render();
      return;
    case "go-sign-in":
      resetHumanVerification();
      state = {
        ...state,
        mode: "sign-in",
        password: "",
        confirmationCode: "",
        error: "",
      };
      render();
      return;
    case "resend-code":
      state = { ...state, loading: true, error: "" };
      render();
      try {
        await resendConfirmationCode();
      } catch (error) {
        state = {
          ...state,
          loading: false,
          error: cleanErrorMessage((error as Error).message),
        };
        render();
      }
      return;
    default:
      return;
  }
}

export function show(options: ShowOptions = {}): void {
  if (typeof document === "undefined") {
    return;
  }

  state = {
    mode: options.initialMode ?? "sign-in",
    firstName: state.firstName,
    lastName: state.lastName,
    email: state.email,
    password: "",
    confirmationCode: "",
    rememberMe: state.rememberMe,
    info: "",
    error: "",
    loading: false,
    allowClose: options.allowClose ?? false,
    config: options.config ?? AUTH_CONFIG,
    avatarType: state.avatarType,
    avatarValue: state.avatarValue,
    turnstileToken: "",
    turnstileProof: "",
    humanVerified: false,
    turnstileError: "",
  };

  ensureOverlay();
  render();
}
