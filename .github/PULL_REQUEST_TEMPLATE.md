## What changes

<!-- The diff shows what. Say why. -->

## How it was verified

<!-- Which tests, or what you ran. "It builds" is not verification. -->

## Checklist

- [ ] `npm run typecheck && npm test` pass
- [ ] Behaviour change has a test that fails without it
- [ ] Generated files regenerated, not hand-edited
- [ ] No hard-coded hosts, keys or IP addresses
- [ ] If it touches authorisation: cross-tenant access still returns 404, not 403
