# Changelog

All notable changes are logged here. New entries go at the top of the `Unreleased` section.
When a version is released, rename `Unreleased` to the version number and date, then add a fresh `Unreleased` heading.

Entry format: `- [tag] Description of change`
Tags: `added`, `fixed`, `changed`, `removed`

---

## Unreleased

- [added] Full conversation transcript logging — saves agent messages, tool traces, and flow state to `conversation_transcripts` table (gated behind `--transcript-logging` / `SHOWRUN_TRANSCRIPT_LOGGING`)
- [added] `agent.transcriptLogging` config option with CLI flag `--transcript-logging` and env var `SHOWRUN_TRANSCRIPT_LOGGING`
- [fixed] Capture thinking output in saved conversation transcripts (was only streamed to client, not persisted)
- [removed] Legacy prompt files `AUTONOMOUS_EXPLORATION_SYSTEM_PROMPT.md`, `TEACH_MODE_SYSTEM_PROMPT.md`, and `output_debug.txt` — only `EXPLORATION_AGENT_SYSTEM_PROMPT.md` is used now
- [changed] Prompt config simplified: `EXPLORATION_AGENT_PROMPT_PATH` replaces `AUTONOMOUS_EXPLORATION_PROMPT_PATH` and `TEACH_MODE_SYSTEM_PROMPT_PATH`
- [added] Official brand logo (icon + "showrun" wordmark) in header and welcome screen, replacing text-only gradient
- [added] `agent.debug` config option (`SHOWRUN_DEBUG` env var) — debug flag can now be set via config.json in addition to `--debug` CLI flag
- [added] CHANGELOG.md and CLAUDE.md rule requiring changelog entries for every change
- [added] `--debug` flag for dashboard — gates failed tool call logging behind a flag instead of always writing to disk
- [changed] Dashboard UI restyled to match brand guidelines (colors, typography, CSS variables)
