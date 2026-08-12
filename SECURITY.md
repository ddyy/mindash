# Security

Report vulnerabilities privately to **dev@daniel-yang.com** - please do
not open public issues for security reports. You should receive a reply
within a few days.

In scope: authentication (passkeys, sessions, recovery), the OAuth/MCP
surface, push ingest, rendering safety (XSS), SSRF via widget fetches,
and the config authorization scopes. The threat model and invariants are
documented throughout the source; `src/vault.ts` and
`src/safefetch.ts` are the load-bearing walls.
