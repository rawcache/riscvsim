import type { AuthConfig } from "./auth";

function normalizedRedirectUri(): string {
  if (typeof window === "undefined") {
    return "http://localhost:5173";
  }

  let pathname = window.location.pathname;
  if (pathname === "/landing.html") {
    pathname = "/";
  } else if (pathname === "/simulator") {
    pathname = "/simulator/";
  } else if (pathname.endsWith("/index.html")) {
    pathname = pathname.slice(0, -10) || "/";
  }

  return new URL(pathname, window.location.origin).toString();
}

export const AUTH_CONFIG: AuthConfig = {
  userPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID ?? "us-east-1_PLACEHOLDER",
  clientId: import.meta.env.VITE_COGNITO_CLIENT_ID ?? "PLACEHOLDER",
  hostedUiDomain:
    import.meta.env.VITE_COGNITO_DOMAIN ?? "studyriscv.auth.us-east-1.amazoncognito.com",
  redirectUri: normalizedRedirectUri(),
};
