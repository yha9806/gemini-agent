# Visual Gate

Use this after changing UI, design, chart, report, canvas, or other visual
surfaces.

## Prerequisites

- Capture screenshots into the current project or working directory.
- Pass screenshot paths as relative paths.
- Use `--smoke-only` for local checks that do not call Gemini.

## Smoke-Only Check

```bash
./bin/gemini-agent visual gate --actual-screenshot after.png --kind ui --smoke-only --json
```

This checks that the screenshot exists, has a supported image type, stays within
the byte limit, and can be inspected enough for a visual workflow.

## Target-vs-Actual Check

```bash
./bin/gemini-agent visual gate \
  --target-screenshot target.png \
  --actual-screenshot after.png \
  --kind ui \
  --risk design-implementation \
  --json
```

This combines local smoke checks with Gemini artifact review when routing says a
review is useful or required.

## Output

The result uses a pass, caution, or block verdict:

```json
{
  "kind": "visual_review_gate",
  "verdict": "caution",
  "review_posture": "comparison_review",
  "risk_level": "high",
  "risk_reasons": ["design_implementation", "target_actual_comparison"]
}
```

Ordinary output avoids raw prompts, raw responses, local paths, media file names,
and image bytes.
