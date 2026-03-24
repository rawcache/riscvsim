import type { AuthConfig } from "./auth";

const DEFAULT_API_ENDPOINT = "https://api.studyriscv.com";

function normalizedRedirectUri(): string {
  if (typeof window === "undefined") {
    return "http://localhost:5173/simulator/";
  }

  return `${window.location.origin}/simulator/`;
}

export const AUTH_CONFIG: AuthConfig = {
  userPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID ?? "us-east-1_PLACEHOLDER",
  clientId: import.meta.env.VITE_COGNITO_CLIENT_ID ?? "PLACEHOLDER",
  hostedUiDomain:
    import.meta.env.VITE_COGNITO_DOMAIN ?? "studyriscv.auth.us-east-1.amazoncognito.com",
  redirectUri: normalizedRedirectUri(),
  apiEndpoint: (import.meta.env.VITE_API_ENDPOINT as string | undefined)?.trim() || DEFAULT_API_ENDPOINT,
  turnstileSiteKey: (import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined)?.trim() ?? "",
};
