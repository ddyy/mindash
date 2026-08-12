declare module "*.yaml" {
  const text: string;
  export default text;
}

declare module "*.sql" {
  const text: string;
  export default text;
}

declare module "*.css" {
  const text: string;
  export default text;
}

declare module "*.client.js" {
  const text: string;
  export default text;
}

// Injected by workers-oauth-provider into the env it passes to handlers.
interface Env {
  OAUTH_PROVIDER: import("@cloudflare/workers-oauth-provider").OAuthHelpers;
  // Optional hardening: overrides the KV-held vault master key with a
  // write-only Worker secret (base64url, 32 bytes). See src/vault.ts.
  MASTER_KEY?: string;
}
