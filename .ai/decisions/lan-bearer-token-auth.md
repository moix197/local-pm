# Bearer-token auth on a LAN-only tool

**Decision:** Every `/api/*` request must carry `Authorization: Bearer <token>`, compared in constant time. The token is auto-generated into `token.local` on first run.

**Why:** "LAN only" is not a trust boundary — any device or person on the same network (guests, other machines, malware) can reach `0.0.0.0:7420`, and the API can spawn processes and run shell commands on the host. So auth is required despite there being no public exposure. Timing-safe compare is used even for a short-lived local token because a plain `===` leaks length/prefix match timing; using the constant-time primitive is nearly free and removes the question entirely rather than reasoning about whether the leak is exploitable here.

**Rejected:** No auth (trusting the LAN) — rejected: the LAN is shared and the API is high-privilege. Plain string compare — rejected: needless timing side-channel when a safe primitive exists.

**Constraints it creates:** The WS upgrade and the MCP adapter must present the same token. `token.local` is a secret — never commit it. New privileged surfaces must go through the same bearer check, not bypass it.
