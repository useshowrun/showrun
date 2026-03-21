#!/usr/bin/env node

/**
 * YouTube Transcript Scraper
 *
 * Extracts full transcripts/captions from any public YouTube video.
 * No API key or login required — intercepts YouTube's timedtext API responses.
 *
 * Strategy:
 *   1. Navigate to the video page with camoufox (fingerprinted Firefox)
 *   2. Add SOCS consent cookie to bypass consent dialog
 *   3. Set up response interceptors for /api/timedtext calls
 *   4. After domcontentloaded, the player initializes and makes timedtext requests
 *   5. Wait for the first relevant timedtext response (up to 15s)
 *   6. Parse events from the JSON3 format into timed segments
 *
 * If the target language wasn't auto-loaded, we check ytInitialPlayerResponse
 * for the available tracks and trigger a fetch for the desired track.
 *
 * Usage:
 *   node youtube-transcript.mjs <videoId|url> [--lang en] [--text-only] [--list-langs]
 *
 * Examples:
 *   node youtube-transcript.mjs dQw4w9WgXcQ
 *   node youtube-transcript.mjs "https://www.youtube.com/watch?v=jNQXAC9IVRw" --lang en
 *   node youtube-transcript.mjs dQw4w9WgXcQ --list-langs
 *   node youtube-transcript.mjs dQw4w9WgXcQ --text-only
 *
 * Output:
 *   RESULT:{json} on stdout, logs to stderr
 */

import { Camoufox } from "camoufox-js";
import {
  emitResult, emitError, log, delay,
  addConsentCookies, extractPageJson,
} from "../../lib/utils.mjs";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let videoInput = null;
let targetLang = null;
let textOnly = false;
let listLangs = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--lang" && args[i + 1]) {
    targetLang = args[i + 1];
    i++;
  } else if (args[i] === "--text-only") {
    textOnly = true;
  } else if (args[i] === "--list-langs") {
    listLangs = true;
  } else if (!args[i].startsWith("--")) {
    videoInput = args[i];
  }
}

if (!videoInput) {
  emitError("MISSING_ARG", "Usage: node youtube-transcript.mjs <videoId|url> [--lang en] [--text-only] [--list-langs]");
}

// ---------------------------------------------------------------------------
// Parse video ID
// ---------------------------------------------------------------------------

function parseVideoId(input) {
  input = input.trim();
  try {
    const url = new URL(input);
    if (url.hostname.includes("youtube.com")) {
      return url.searchParams.get("v") || null;
    }
    if (url.hostname === "youtu.be") {
      return url.pathname.slice(1).split("/")[0] || null;
    }
  } catch (_) {}
  if (/^[A-Za-z0-9_-]{11}$/.test(input)) return input;
  return null;
}

const videoId = parseVideoId(videoInput);
if (!videoId) {
  emitError("INVALID_INPUT", `Cannot parse video ID from: ${videoInput}`);
}

const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

// ---------------------------------------------------------------------------
// Parse transcript events into segments
// ---------------------------------------------------------------------------

function parseTranscriptEvents(events) {
  const segments = [];
  for (const ev of events) {
    if (!ev.segs) continue;
    const text = ev.segs
      .map((s) => s.utf8 || s.u || "")
      .join("")
      .replace(/\n/g, " ")
      .trim();
    if (!text) continue;

    const startMs = ev.tStartMs || 0;
    const durationMs = ev.dDurationMs || 0;

    segments.push({
      startMs,
      durationMs,
      startSeconds: Math.round(startMs / 100) / 10,
      endSeconds: Math.round((startMs + durationMs) / 100) / 10,
      text,
    });
  }
  return segments;
}

// ---------------------------------------------------------------------------
// Parse XML fallback format
// ---------------------------------------------------------------------------

function parseXmlTranscript(xmlText) {
  const segments = [];
  const regex = /<text start="([^"]+)" dur="([^"]+)"[^>]*>([\s\S]*?)<\/text>/g;
  let match;
  while ((match = regex.exec(xmlText)) !== null) {
    const startSec = parseFloat(match[1]);
    const durSec = parseFloat(match[2]);
    const rawText = match[3]
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/<[^>]+>/g, "")
      .trim();
    if (!rawText) continue;
    segments.push({
      startMs: Math.round(startSec * 1000),
      durationMs: Math.round(durSec * 1000),
      startSeconds: Math.round(startSec * 10) / 10,
      endSeconds: Math.round((startSec + durSec) * 10) / 10,
      text: rawText,
    });
  }
  return segments;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log(`[youtube-transcript] Video: ${videoId}`);

  const browser = await Camoufox({ headless: true });

  try {
    const context = await browser.newContext({
      locale: "en-US",
      timezoneId: "America/New_York",
    });

    await addConsentCookies(context);

    const page = await context.newPage();

    // ---- Intercept timedtext responses ----
    const capturedTranscripts = new Map(); // lang -> { text, fmt }
    let resolveFirstTranscript;
    const firstTranscriptPromise = new Promise((resolve) => {
      resolveFirstTranscript = resolve;
    });

    page.on("response", async (response) => {
      const url = response.url();
      if (!url.includes("/api/timedtext")) return;

      const urlObj = new URL(url);
      const lang = urlObj.searchParams.get("lang") || "unknown";
      const fmt = urlObj.searchParams.get("fmt") || "xml";
      const status = response.status();

      if (status !== 200) return;

      try {
        const buffer = await response.body();
        const text = buffer.toString("utf8");
        if (text && text.length > 50) {
          log(`[youtube-transcript] Intercepted: lang=${lang} fmt=${fmt} len=${text.length}`);
          capturedTranscripts.set(lang, { text, fmt, rawUrl: url });
          resolveFirstTranscript({ lang, text, fmt, rawUrl: url });
        }
      } catch (_) {
        // Ignore
      }
    });

    // Navigate to the video page
    log(`[youtube-transcript] Navigating to ${videoUrl}`);
    await page.goto(videoUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    // Wait for timedtext response (up to 15s) or fall through
    const firstTranscript = await Promise.race([
      firstTranscriptPromise,
      delay(15000).then(() => null),
    ]);

    if (firstTranscript) {
      log(`[youtube-transcript] Got intercepted transcript for lang=${firstTranscript.lang}`);
    }

    // Extract ytInitialPlayerResponse for metadata and track list
    const playerDataStr = await extractPageJson(page, "ytInitialPlayerResponse");

    if (!playerDataStr) {
      await browser.close();
      emitError("PARSE_ERROR", "Could not extract ytInitialPlayerResponse from page");
    }

    const playerData = JSON.parse(playerDataStr);

    // Check video playability
    const playabilityStatus = playerData.playabilityStatus?.status;
    if (playabilityStatus === "ERROR" || playabilityStatus === "LOGIN_REQUIRED") {
      await browser.close();
      emitError(
        "VIDEO_UNAVAILABLE",
        `Video unavailable: ${playerData.playabilityStatus?.reason || playabilityStatus}`
      );
    }

    const videoTitle = playerData.videoDetails?.title || null;
    const captionTracks = playerData.captions
      ?.playerCaptionsTracklistRenderer?.captionTracks || [];
    const translationLanguages = playerData.captions
      ?.playerCaptionsTracklistRenderer?.translationLanguages || [];

    log(`[youtube-transcript] Caption tracks: ${captionTracks.length}`);
    log(`[youtube-transcript] Captured: ${[...capturedTranscripts.keys()].join(", ") || "(none)"}`);

    if (captionTracks.length === 0 && capturedTranscripts.size === 0) {
      await browser.close();
      emitResult({
        videoId,
        videoUrl,
        title: videoTitle,
        error: true,
        code: "NO_TRANSCRIPT",
        message: "This video has no available transcripts/captions",
        availableLanguages: [],
      });
      return;
    }

    // Build available languages list
    const availableLanguages = captionTracks.map((t) => ({
      code: t.languageCode,
      name: t.name?.simpleText || t.languageCode,
      isAutoGenerated: t.kind === "asr",
      baseUrl: t.baseUrl,
    }));

    log(`[youtube-transcript] Available: ${availableLanguages.map((l) => `${l.code}(${l.isAutoGenerated ? "asr" : "manual"})`).join(", ")}`);

    if (listLangs) {
      await browser.close();
      emitResult({
        videoId,
        videoUrl,
        title: videoTitle,
        availableLanguages: availableLanguages.map(({ code, name, isAutoGenerated }) => ({
          code, name, isAutoGenerated,
        })),
        translationCount: translationLanguages.length,
      });
      return;
    }

    // Select the best caption track
    let selectedTrack = null;

    if (targetLang) {
      selectedTrack =
        availableLanguages.find(
          (l) => l.code === targetLang || l.code.startsWith(targetLang + "-")
        ) ||
        availableLanguages.find((l) =>
          l.code.toLowerCase().startsWith(targetLang.toLowerCase())
        );

      if (!selectedTrack) {
        await browser.close();
        emitResult({
          videoId,
          videoUrl,
          title: videoTitle,
          error: true,
          code: "LANG_NOT_FOUND",
          message: `Language '${targetLang}' not available. Available: ${availableLanguages.map((l) => l.code).join(", ")}`,
          availableLanguages: availableLanguages.map(({ code, name, isAutoGenerated }) => ({
            code, name, isAutoGenerated,
          })),
        });
        return;
      }
    } else {
      // Auto-select: prefer manual English, then auto English, then manual any, then auto any
      selectedTrack =
        availableLanguages.find((l) => l.code.startsWith("en") && !l.isAutoGenerated) ||
        availableLanguages.find((l) => l.code.startsWith("en") && l.isAutoGenerated) ||
        availableLanguages.find((l) => !l.isAutoGenerated) ||
        availableLanguages[0] ||
        null;
    }

    log(`[youtube-transcript] Selected: ${selectedTrack?.code} (${selectedTrack?.name}) [${selectedTrack?.isAutoGenerated ? "asr" : "manual"}]`);

    // Find captured transcript for this language
    let transcriptText = null;
    let transcriptFmt = "json3";

    if (selectedTrack) {
      // Look for exact or prefix match
      for (const [lang, captured] of capturedTranscripts) {
        if (
          lang === selectedTrack.code ||
          lang === selectedTrack.code.split("-")[0] ||
          selectedTrack.code.startsWith(lang)
        ) {
          transcriptText = captured.text;
          transcriptFmt = captured.fmt;
          log(`[youtube-transcript] Using intercepted transcript for ${lang}`);
          break;
        }
      }
    }

    // If not captured yet, try to fetch the target language transcript
    // Strategy: use the captured timedtext URL as a base, modify lang param,
    // and fetch via XHR in page context (which has access to browser's auth/cookies)
    if (!transcriptText && capturedTranscripts.size > 0) {
      // We have a captured URL - use any captured URL and modify the lang param
      const capturedRawUrl = [...capturedTranscripts.values()][0]?.rawUrl;

      if (capturedRawUrl) {
        log(`[youtube-transcript] Fetching ${selectedTrack.code} by modifying captured URL lang param`);
        const modifiedUrl = new URL(capturedRawUrl);
        modifiedUrl.searchParams.set("lang", selectedTrack.code);
        modifiedUrl.searchParams.set("fmt", "json3");

        const result = await page.evaluate(async (url) => {
          return new Promise((resolve) => {
            const xhr = new XMLHttpRequest();
            xhr.open("GET", url, true);
            xhr.timeout = 10000;
            xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText });
            xhr.onerror = () => resolve({ error: "XHR error" });
            xhr.ontimeout = () => resolve({ error: "timeout" });
            xhr.send();
          });
        }, modifiedUrl.toString());

        if (result.text && result.text.length > 50) {
          transcriptText = result.text;
          transcriptFmt = "json3";
          log(`[youtube-transcript] Got ${selectedTrack.code} via URL modification: ${result.text.length} bytes`);
        }
      }
    }

    // Last resort: re-navigate with the target language and wait for intercept
    if (!transcriptText && selectedTrack?.baseUrl) {
      log(`[youtube-transcript] Re-navigating for lang: ${selectedTrack.code}`);

      capturedTranscripts.clear();
      let resolveTargetTranscript;
      const targetTranscriptPromise = new Promise((resolve) => {
        resolveTargetTranscript = resolve;
      });

      const langCode = selectedTrack.code;
      const langListener = async (response) => {
        const url = response.url();
        if (!url.includes("/api/timedtext")) return;
        const urlObj = new URL(url);
        const lang = urlObj.searchParams.get("lang") || "unknown";
        if (response.status() !== 200) return;
        try {
          const buffer = await response.body();
          const text = buffer.toString("utf8");
          if (text && text.length > 50) {
            log(`[youtube-transcript] Captured ${lang}: ${text.length} bytes`);
            // If this is the language we want, or we accept any
            resolveTargetTranscript({ lang, text, fmt: urlObj.searchParams.get("fmt") || "xml", rawUrl: url });

            // Also try modifying this URL for the target lang if different
            if (lang !== langCode) {
              const modifiedUrl = new URL(url);
              modifiedUrl.searchParams.set("lang", langCode);
              modifiedUrl.searchParams.set("fmt", "json3");
              // Store for later use
              capturedTranscripts.set("rawUrl_" + lang, { rawUrl: url, text: "", fmt: "json3" });
            }
          }
        } catch (_) {}
      };
      page.on("response", langListener);

      const langUrl = `${videoUrl}&hl=${selectedTrack.code.split("-")[0]}`;
      await page.goto(langUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });

      const capturedAny = await Promise.race([
        targetTranscriptPromise,
        delay(15000).then(() => null),
      ]);

      page.off("response", langListener);

      if (capturedAny) {
        if (capturedAny.lang === langCode || langCode.startsWith(capturedAny.lang)) {
          transcriptText = capturedAny.text;
          transcriptFmt = capturedAny.fmt;
        } else {
          // Got a different lang - try to modify the URL to get our target lang
          const modifiedUrl = new URL(capturedAny.rawUrl);
          modifiedUrl.searchParams.set("lang", langCode);
          modifiedUrl.searchParams.set("fmt", "json3");

          const xhrResult = await page.evaluate(async (url) => {
            return new Promise((resolve) => {
              const xhr = new XMLHttpRequest();
              xhr.open("GET", url, true);
              xhr.timeout = 10000;
              xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText });
              xhr.onerror = () => resolve({ error: "XHR error" });
              xhr.ontimeout = () => resolve({ error: "timeout" });
              xhr.send();
            });
          }, modifiedUrl.toString());

          if (xhrResult.text && xhrResult.text.length > 50) {
            transcriptText = xhrResult.text;
            transcriptFmt = "json3";
            log(`[youtube-transcript] Got ${langCode} via URL modification: ${xhrResult.text.length} bytes`);
          } else {
            // Fallback: use the captured language (best we can do)
            transcriptText = capturedAny.text;
            transcriptFmt = capturedAny.fmt;
            log(`[youtube-transcript] Warning: using ${capturedAny.lang} instead of ${langCode} (XHR failed)`);
          }
        }
      }
    }

    // If we still don't have a transcript, use any captured one
    if (!transcriptText && capturedTranscripts.size > 0) {
      const first = capturedTranscripts.values().next().value;
      transcriptText = first.text;
      transcriptFmt = first.fmt;
      log(`[youtube-transcript] Using fallback captured transcript`);
    }

    await browser.close();

    if (!transcriptText) {
      emitResult({
        videoId,
        videoUrl,
        title: videoTitle,
        error: true,
        code: "FETCH_FAILED",
        message: "Could not capture transcript. The player may not have loaded captions.",
        language: selectedTrack?.code || null,
        availableLanguages: availableLanguages.map(({ code, name, isAutoGenerated }) => ({
          code, name, isAutoGenerated,
        })),
      });
      return;
    }

    // Parse the transcript
    let segments = [];

    if (transcriptFmt === "json3" || transcriptText.trim().startsWith("{")) {
      try {
        const json3Data = JSON.parse(transcriptText);
        segments = parseTranscriptEvents(json3Data.events || []);
      } catch (e) {
        log(`[youtube-transcript] JSON parse failed, trying XML: ${e.message}`);
        segments = parseXmlTranscript(transcriptText);
      }
    } else {
      segments = parseXmlTranscript(transcriptText);
    }

    log(`[youtube-transcript] Parsed ${segments.length} segments`);

    if (segments.length === 0) {
      emitResult({
        videoId,
        videoUrl,
        title: videoTitle,
        error: true,
        code: "EMPTY_TRANSCRIPT",
        message: "Transcript captured but contained no text segments",
        language: selectedTrack?.code || null,
      });
      return;
    }

    // Build plain text
    const fullText = segments.map((s) => s.text).join(" ");

    // Total duration
    const lastSeg = segments[segments.length - 1];
    const totalDurationSeconds = lastSeg
      ? Math.round((lastSeg.startMs + lastSeg.durationMs) / 100) / 10
      : 0;

    emitResult({
      videoId,
      videoUrl,
      title: videoTitle,
      language: selectedTrack?.code || "en",
      languageName: selectedTrack?.name || "English",
      isAutoGenerated: selectedTrack?.isAutoGenerated ?? false,
      availableLanguages: availableLanguages.map(({ code, name, isAutoGenerated }) => ({
        code, name, isAutoGenerated,
      })),
      segments: textOnly ? undefined : segments,
      text: fullText,
      meta: {
        segmentCount: segments.length,
        totalDurationSeconds,
      },
    });
  } catch (err) {
    await browser.close().catch(() => {});
    emitError("UNEXPECTED_ERROR", err.message);
  }
}

main().catch((err) => {
  emitError("FATAL", err.message);
});
