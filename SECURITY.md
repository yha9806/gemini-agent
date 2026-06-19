# Security Policy

## Reporting A Vulnerability

Do not disclose vulnerabilities in a public issue.

Use GitHub private vulnerability reporting if it is available for the
repository. If private reporting is not available, open a minimal public issue
asking for a secure contact path, but do not include exploit details, secrets,
raw telemetry, screenshots, or customer data.

Please include:

- The affected command, file, or workflow.
- The impact and the conditions required to trigger it.
- A minimal reproduction that does not include secrets or private data.
- Any known workaround.

## Data Handling

`gemini-agent` is local-first, but some commands send prompts, code snippets,
diffs, screenshots, or generated summaries to the Gemini API. Raw telemetry mode
can store prompts and responses and requires `--confirm-raw-content`. Enable it
only when your project data policy permits it.

Never include API keys, bearer tokens, raw telemetry exports, private
screenshots, or customer data in public issues or pull requests.

## Supported Versions

Security fixes are handled on the default branch and documented in follow-up
release notes or patch tags when they affect a published source release.
