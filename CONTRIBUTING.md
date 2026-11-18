# Contributing

Thanks for your interest! Bug reports, ideas and pull requests are welcome.

## Setup

```bash
git clone https://github.com/Ludoo0/untis-mcp.git
cd untis-mcp
bun install
bun run lint        # Biome: lint + formatting check (bun run format fixes formatting)
bun run typecheck
bun test
```

Requirements: [Bun](https://bun.sh) ≥ 1.4. Docker is optional (`docker compose up -d --build`).

To try changes against a real account, copy `.env.example` to `.env`, set `UNTIS_QR_URL` and use `bun run call <tool> [key=value…]` or `bun run smoke --details`. **Bun loads `.env` automatically** – when you run things that should *not* touch your account, override `UNTIS_QR_URL` with a dummy value (e.g. `untis://setschool?url=example.invalid&school=x&user=x&key=ABCDEFGHIJKLMNOP`).

## Ground rules

- **Never commit or post real data.** No real names, class names, messages, files, school hosts, school login names or IDs – not in code, tests, issues, PRs or screenshots. Tests use fictional data only (`test/fixtures.ts`).
- **Read-only.** The server must never change anything in WebUntis: only `GET` requests and the allowlisted JSON-RPC read methods (spec section 1). No read confirmations, replies, excuses or deletes.
- **Allowlist DTOs.** Tools return explicitly mapped fields – never pass raw API responses through. Never map participant lists, gender, `gradeProtection`, `disadvantageCompensation`, grades or staff notes.
- **Register, then redact.** Register every person from an API response in the person registry *before* redacting text of that response. All free text goes through `ctx.redactor.text()` / `.title()` / `.optional()`, file names through `redactFileName()`.
- **Secrets stay inside.** App secret, password, TOTP codes, `JSESSIONID`, JWT and signed storage URLs never appear in tool output or logs. External links only via `isShareableUrl()`.
- **`structuredContent` is the contract.** Some clients only show structured content – everything an agent needs must be in it.
- **English** for code, comments, docs, tool descriptions and error messages. User-facing labels live in `src/redaction/labels.ts`.
- Logs go to stderr and never contain content.

## Pull request checklist

- [ ] `bun run lint`, `bun run typecheck` and `bun test` pass
- [ ] New behaviour is covered by tests with fictional data
- [ ] Redaction-relevant changes: a regression test that would have caught the leak, and `bun run smoke` against a real account reports no findings (if you have one)
- [ ] No real data, school hosts or IDs anywhere in the diff
- [ ] Docs updated (`README.md`, `docs/`) and an entry under `[Unreleased]` in `CHANGELOG.md`
- [ ] Commit messages in English

## Reporting bugs

Use GitHub issues for regular bugs and ideas. Describe patterns, not content. **Redaction leaks and other security issues go through private reporting** – see [SECURITY.md](SECURITY.md).
