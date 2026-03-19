import { AUTH_CONFIG } from "./auth-config";
import { storeSessionTokens } from "./auth";
import type { AuthConfig, UserSession } from "./auth";

type Mode = "sign-in" | "sign-up" | "confirm-sign-up" | "forgot-password" | "reset-password";

type ModalState = {
  mode: Mode;
  email: string;
  password: string;
  confirmationCode: string;
  info: string;
  error: string;
  loading: boolean;
  allowClose: boolean;
  config: AuthConfig;
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

const COGNITO_ENDPOINT = "https://cognito-idp.us-east-1.amazonaws.com/";
const EVENT_NAME = "studyriscv-auth-changed";

let overlayEl: HTMLElement | null = null;
let state: ModalState = {
  mode: "sign-in",
  email: "",
  password: "",
  confirmationCode: "",
  info: "",
  error: "",
  loading: false,
  allowClose: false,
  config: AUTH_CONFIG,
};

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

function render(): void {
  if (!overlayEl) {
    return;
  }

  overlayEl.innerHTML = `
    <div class="auth-modal__backdrop"></div>
    <div class="auth-modal__card" role="dialog" aria-modal="true" aria-labelledby="authModalTitle">
      ${
        state.allowClose
          ? '<button class="auth-modal__close" type="button" data-auth-action="close" aria-label="Close auth dialog">×</button>'
          : ""
      }
      <div class="auth-modal__brand">StudyRISC-V</div>
      <div id="authModalTitle" class="auth-modal__subhead">${escapeHtml(titleForMode(state.mode))}</div>
      <form class="auth-modal__form" data-auth-action="submit">
        ${renderFields()}
        ${infoLine() ? `<div class="auth-modal__info">${infoLine()}</div>` : ""}
        ${state.error ? `<div class="auth-modal__error">${escapeHtml(state.error)}</div>` : ""}
        <button class="auth-modal__primary" type="submit" ${state.loading ? "disabled" : ""}>
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
      const key = target.dataset.authInput as "email" | "password" | "confirmationCode";
      state = { ...state, [key]: target.value, error: "" };
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
  });

  if (!session) {
    throw new Error("Unable to start a session. Try again.");
  }

  dispatchAuthChange(session);
  close();
}

async function signUp(): Promise<void> {
  const payload = await cognitoRequest("SignUp", {
    ClientId: state.config.clientId,
    Username: state.email.trim(),
    Password: state.password,
    UserAttributes: [{ Name: "email", Value: state.email.trim() }],
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
    email: state.email,
    password: "",
    confirmationCode: "",
    info: "",
    error: "",
    loading: false,
    allowClose: options.allowClose ?? false,
    config: options.config ?? AUTH_CONFIG,
  };

  ensureOverlay();
  render();
}
