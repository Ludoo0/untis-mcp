## What does this change?

## Checklist

- [ ] `bun run lint`, `bun run typecheck` and `bun test` pass
- [ ] New output fields go through the redactor (`ctx.redactor.text()` / `.title()` / `redactFileName()`) and persons are registered **before** redacting
- [ ] Tool outputs stay allowlist DTOs (no raw API responses passed through)
- [ ] Tests use only fake data – no real names, IDs, class names or hosts of a real account
- [ ] If tested against a real account: `bun run smoke --details` reports no leaks
- [ ] Docs / CHANGELOG updated where relevant
