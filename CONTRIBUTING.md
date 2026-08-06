# Contributing to VoiceKernel

Thanks for looking. This is a control plane that sits in front of a realtime
voice provider and enforces tenant isolation, so the bar for changes touching
authorisation is higher than for most projects. Everything else is ordinary.

## Getting set up

```bash
npm install
cp .env.example .env      # DATABASE_URL, JWT_SECRET, ENCRYPTION_KEY at minimum
npm run db:up && npm run migrate
npm run seed              # prints a generated admin password, once
npm run dev
```

Tests run against a real server and a real database, not mocks:

```bash
npm run dev               # in one shell
npm test                  # in another
npm run test:sdk
npm run typecheck
```

That is deliberate. The properties worth testing here - tenant isolation, scope
enforcement, idempotency - are properties of the whole stack. A mocked proxy
will happily pass an isolation test that production fails.

Tests that need a live provider credential skip themselves, loudly, unless
`PROVIDER_API_KEY` is set. They say so rather than reporting green.

## Before opening a pull request

- `npm run typecheck && npm test` pass.
- A behaviour change comes with a test that fails without it.
- Generated files are regenerated, never hand-edited. If the upstream OpenAPI
  document changes, run `npm run gen:provider`. If an endpoint exists that the
  document omits, add it to `SUPPLEMENTAL_OPERATIONS` in the generator with a
  note on how you confirmed it, so it survives regeneration.
- No new dependency in `packages/sdk-typescript`. It is zero-dependency on
  purpose; anyone integrating a voice layer already has enough supply chain.

## Things that will get a change sent back

**Weakening the choke point.** Every provider call goes through
`proxyToProvider`. If you need something it does not allow, extend the policy
model rather than reaching around it. `adoptUnowned` is the pattern to copy: it
moves a check, and the proxy re-verifies rather than trusting the caller.

**403 where the code returns 404.** Cross-tenant reads answer `404` on purpose.
Confirming that an id exists tells an attacker it is real and belongs to
somebody.

**Optimistic reporting.** If a check could not run, say so. Monitors report
`unknown` rather than `ok`; DNC wash reports `not_available` when no provider
is configured; billing states plainly that no integration exists. A green tick
that means "we did not look" is worse than a blank.

**Hard-coded hosts, keys or IP addresses.** This repository is public. Deploy
targets come from arguments or environment.

## Commit messages

Explain why, not what - the diff already shows what. If you fixed something
subtle, the next person needs to know what it looked like when broken, or they
will reintroduce it.

## Where help is most useful

- Additional provider adapters and catalogue coverage.
- Analytics beyond call basics.
- Eval tooling - currently a scaffold.
- A Python SDK matching the TypeScript one's semantics.
- Postgres `LISTEN/NOTIFY` for realtime, so the API can run more than one
  replica. See the note in `src/services/realtime.ts`.

## Code of conduct

Be decent. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
