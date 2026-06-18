# Contributing

Thanks for helping improve `gemini-agent`. The project is still early, so the
most useful contributions are focused fixes, small workflow improvements, and
documentation that makes the tool easier to run safely.

## Local Setup

```bash
npm install
npm test
```

Normal `npm test` must stay offline and must not require Gemini credentials.
Live Gemini smoke tests are opt-in:

```bash
GEMINI_AGENT_RUN_LIVE_TESTS=1 npm run test:live
```

## Pull Requests

- Keep changes scoped to one behavior or documentation improvement.
- Add or update tests for behavior changes.
- Run the focused test you changed and `npm test` before opening a pull request.
- Run `npm audit --omit=dev` after dependency changes.
- Keep `.gemini-agent/`, raw telemetry exports, generated screenshots,
  scheduler env files, and credentials out of commits.

## Safety Expectations

`gemini-agent` gives advice, summaries, reviews, and artifacts. It must not
become the authority for editing source, running tests, committing, deploying,
or making final release decisions. Preserve that boundary in new features and
documentation.
