import crypto from "node:crypto";

export const resolveExternalE2eToken = (
  externalBaseURL: string | undefined,
  value = process.env.WMUX_E2E_TOKEN,
): string | undefined => {
  if (!externalBaseURL) return undefined;
  const token = value;
  if (!token || token !== token.trim() || token.length < 32 || token.length > 512
    || !/^[\x21-\x7e]+$/.test(token)) {
    throw new Error("WMUX_E2E_TOKEN must be 32-512 printable ASCII characters without spaces for external E2E");
  }
  return token;
};

export const deriveExternalE2eRegistrationToken = (token: string): string =>
  crypto.createHash("sha256").update(`wmux-e2e-registration\0${token}`).digest("base64url");

export const e2eRegistrationToken = (): string => {
  const externalBaseURL = process.env.WMUX_E2E_BASE_URL?.trim();
  if (!externalBaseURL) return "e2e-registration-token";
  return deriveExternalE2eRegistrationToken(resolveExternalE2eToken(externalBaseURL)!);
};
