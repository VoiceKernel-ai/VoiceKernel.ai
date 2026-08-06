# Security policy

## Reporting a vulnerability

Please do not open a public issue.

Use GitHub's private vulnerability reporting on this repository
(Security → Report a vulnerability), which routes straight to the maintainers.

Useful things to include: what you did, what happened, what you expected, and
whether it needs an authenticated session or an API key. A proof of concept
helps but is not required to start the conversation.

We will acknowledge and give an assessment with a rough timeline, and will
credit you when a fix ships unless you would rather we did not.

## Scope

This project is a control plane in front of a realtime voice provider. The
areas where a bug matters most:

- **Tenant isolation.** Any path where one organisation can read, modify or
  delete another's resources. The ownership registry is the boundary; the proxy
  enforces it before any upstream call.
- **Credential handling.** Provider keys are encrypted at rest and redacted
  from logs. Anything that surfaces one in a response, a log line or an error
  is a vulnerability.
- **Scope enforcement.** An API key acting beyond its granted scopes.
- **Webhook verification.** Signature or replay-window weaknesses in either
  direction.
- **Erasure.** Personal data surviving a completed erasure request.

## Not in scope

- Vulnerabilities in the upstream voice provider - report those to them.
- Missing hardening on a deployment you control (an origin bound to `0.0.0.0`,
  a `.env` with weak secrets). The defaults ship safe; the deployment is yours.
- Findings from automated scanners with no demonstrated impact.

## Deployment notes

If you run this yourself:

- Set `ENCRYPTION_KEY` and `JWT_SECRET` to strong random values, and keep them.
  Losing `ENCRYPTION_KEY` makes stored provider keys unrecoverable; changing
  `JWT_SECRET` invalidates every session.
- Bind the API to a private interface and put a reverse proxy in front. It is
  never intended to face the internet directly.
- `npm run seed` generates a random admin password and prints it once. There is
  nowhere to look it up afterwards.
- Set `ALLOW_SIGNUP=false` on any deployment that is not open to public signup.
