---
name: showrun-local-collector-setup
description: Set up or troubleshoot a local ShowRun Collector for OpenClaw sub-agent use, including local ShowRun skills, browser/profile auth, and source-access readiness.
---

# ShowRun Local Collector Setup

Use this when installing, checking, or fixing the local ShowRun Collector environment.

## Goal

Local-first architecture:

```text
VC Research Lead → local isolated ShowRun Collector sub-agent → ShowRun skills/browser auth
```

No VPS or public API is required for the default setup.

## Checklist

- ShowRun skills are installed locally and available in the workspace.
- The Collector can read relevant `SKILL.md` files before using a skill.
- Authenticated sources use local browser/profile auth; never ask for raw passwords.
- If a needed source is not connected, report the exact source and question it would answer.
- If a local skill/path/CDP issue is safely repairable, fix it and retry.

## Browser auth

Prefer connected local browser/profile access for gated sources such as PitchBook, Crunchbase, LinkedIn, GovTribe, or similar. Browser Use Cloud can be used later as a profile provider, but the Collector should only care that the source/profile is connected.

## Collector behavior

The Collector returns evidence, not investment judgment:

- source URLs,
- confidence,
- tools/sources used,
- unresolved gaps,
- source access needed.

Do not invent facts when sources are missing.
