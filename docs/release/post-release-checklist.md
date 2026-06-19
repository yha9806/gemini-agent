# Post-Release Checklist

Use this after publishing a GitHub source release.

## GitHub Release

- Confirm the release tag points at the intended `main` commit.
- Confirm the release is not a draft unless intentionally staged.
- Confirm the release notes mention install path, package privacy, verification,
  safety model, and known limits.
- Confirm the repository About description and topics match the README
  positioning.

## Repository Hygiene

- Confirm issue templates route bugs, feature requests, and security reports to
  the right place.
- Confirm the default branch has passing CI after the release merge.
- Confirm `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, and release notes do
  not include local paths, credentials, raw telemetry, private screenshots, or
  customer data.
- Confirm `npm pack --dry-run` does not include local artifacts or unintended
  release-only files.

## Smoke Checks

```bash
npm install
npm test
npm audit --omit=dev
npm pack --dry-run
./bin/gemini-agent --help
./bin/gemini-agent auth status
```

Optional live validation, only when project data policy allows external Gemini
calls:

```bash
./bin/gemini-agent ask "Reply with exactly: gemini-agent-ok"
./bin/gemini-agent diff-review --smart-diff
```

## Follow-Up Monitoring

- Watch new issues for install friction, unclear command selection, and
  credential or telemetry confusion.
- Keep raw telemetry and screenshot examples out of public issues unless they
  are synthetic fixtures.
- Prefer small patch releases for documentation, safety wording, and workflow
  clarity fixes.
