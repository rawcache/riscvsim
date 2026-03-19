import type { AuthConfig } from "./auth";

export const AUTH_CONFIG: AuthConfig = {
  userPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID ?? "us-east-1_PLACEHOLDER",
  clientId: import.meta.env.VITE_COGNITO_CLIENT_ID ?? "PLACEHOLDER",
  hostedUiDomain:
    import.meta.env.VITE_COGNITO_DOMAIN ?? "studyriscv.auth.us-east-1.amazoncognito.com",
  redirectUri: typeof window !== "undefined" ? window.location.origin : "http://localhost:5173",
};
