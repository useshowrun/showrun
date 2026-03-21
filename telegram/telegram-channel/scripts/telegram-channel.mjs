#!/usr/bin/env node

/**
 * Telegram Channel Scraper
 *
 * Scrapes public Telegram channel messages, member counts, and metadata.
 * Uses the public t.me/s/{channel} web view — no login or API key required.
 *
 * Strategy:
 *   1. Navigate to https://t.me/s/{channel} with camoufox (fingerprinted Firefox)
 *   2. Parse channel info from header (title, subscribers, description, photo)
 *   3. Parse all message blocks from the page HTML
 *   4. Paginate by following the ?before={messageId} link
 *
 * Data extracted per message:
 *   - messageId, messageUrl, datetime, text, mediaType
 *   - photoUrls, videoUrl, videoDuration (for media messages)
 *   - linkPreview (site, title, description, image)
 *   - forwardedFrom, links, hashtags
 *   - views, reactions, totalReactions
 *
 * Usage:
 *   node telegram-channel.mjs <channel> [--max 20] [--before <id>]
 *
 * Arguments:
 *   <channel>       Channel username (e.g. "durov", "@durov", "https://t.me/durov")
 *   --max N         Maximum number of messages to return (default: 20)
 *   --before ID     Start fetching from before this message ID (for pagination)
 *
 * Environment:
 *   SOCKS5_PROXY    Optional SOCKS5 proxy host:port (e.g. "127.0.0.1:11090")
 *
 * Examples:
 *   node telegram-channel.mjs durov
 *   node telegram-channel.mjs @telegram --max 50
 *   node telegram-channel.mjs "https://t.me/bbcnews" --max 10
 *   node telegram-channel.mjs durov --before 400 --max 5
 *
 * Output:
 *   RESULT:{json} on stdout, logs to stderr
 */

import { Camoufox } from "camoufox-js";
import {
  emitResult, emitError, log, delay,
  parseChannelUsername, parseChannelInfo, parseMessageHtml, fetchTelegramPage,
} from "../../lib/utils.mjs";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let channelInput = null;
let maxMessages = 20;
let startBeforeId = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--max" && args[i + 1]) {
    maxMessages = parseInt(args[i + 1], 10);
    i++;
  } else if (args[i] === "--before" && args[i + 1]) {
    startBeforeId = parseInt(args[i + 1], 10);
    i++;
  } else if (!args[i].startsWith("--")) {
    channelInput = args[i];
  }
}

if (!channelInput) {
  emitError(
    "MISSING_ARG",
    "Usage: node telegram-channel.mjs <channel> [--max N] [--before ID]"
  );
}

const channelUsername = parseChannelUsername(channelInput);
if (!channelUsername) {
  emitError("INVALID_INPUT", `Cannot parse channel username from: ${channelInput}`);
}

// ---------------------------------------------------------------------------
// Parse messages from HTML page
// ---------------------------------------------------------------------------

function parseMessagesFromHtml(html, channelUsername) {
  // Split HTML into individual message blocks by the wrap div
  const messageBlocks = html.split('class="tgme_widget_message_wrap js-widget_message_wrap"');
  const messages = [];

  for (let i = 1; i < messageBlocks.length; i++) {
    const block = messageBlocks[i];
    // Each block ends at the next tgme_widget_message_wrap or end of messages section
    const parsed = parseMessageHtml(block, channelUsername);
    if (parsed) {
      messages.push(parsed);
    }
  }

  return messages;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log(`[telegram-channel] Channel: ${channelUsername}, max: ${maxMessages}`);

  const proxyEnv = process.env.SOCKS5_PROXY;

  const camoufoxOptions = {
    headless: true,
  };

  if (proxyEnv) {
    const [proxyHost, proxyPort] = proxyEnv.split(":");
    camoufoxOptions.firefoxUserPrefs = {
      "network.proxy.type": 1,
      "network.proxy.socks": proxyHost,
      "network.proxy.socks_port": parseInt(proxyPort, 10),
      "network.proxy.socks_version": 5,
      "network.proxy.socks_remote_dns": true,
    };
    log(`[telegram-channel] Using SOCKS5 proxy: ${proxyEnv}`);
  }

  const browser = await Camoufox(camoufoxOptions);

  try {
    const context = await browser.newContext({
      locale: "en-US",
      timezoneId: "America/New_York",
    });

    const page = await context.newPage();

    // ---- Fetch the first page ----
    const firstPage = await fetchTelegramPage(page, channelUsername, startBeforeId);

    if (!firstPage.isChannel) {
      await browser.close();
      emitResult({
        error: true,
        code: "NOT_FOUND",
        message: `Channel @${channelUsername} not found or is not a public channel`,
        channel: channelUsername,
      });
      return;
    }

    // Parse channel info from first page
    const channelInfo = parseChannelInfo(firstPage.html, channelUsername);
    log(`[telegram-channel] Channel: ${channelInfo.title} (${channelInfo.subscriberText} subscribers)`);

    // Parse messages from first page
    const allMessages = parseMessagesFromHtml(firstPage.html, channelUsername);
    log(`[telegram-channel] Page 1: ${allMessages.length} messages`);

    // Paginate if needed
    let nextBeforeId = firstPage.nextBeforeId;
    let pageCount = 1;

    while (allMessages.length < maxMessages && nextBeforeId !== null) {
      await delay(1000); // Polite delay between pages

      const nextPage = await fetchTelegramPage(page, channelUsername, nextBeforeId);
      if (!nextPage.isChannel) {
        log(`[telegram-channel] Pagination stopped — page not accessible`);
        break;
      }

      const newMessages = parseMessagesFromHtml(nextPage.html, channelUsername);
      log(`[telegram-channel] Page ${pageCount + 1}: ${newMessages.length} messages (before=${nextBeforeId})`);

      if (newMessages.length === 0) {
        log(`[telegram-channel] No more messages`);
        break;
      }

      allMessages.push(...newMessages);
      nextBeforeId = nextPage.nextBeforeId;
      pageCount++;

      if (nextBeforeId === null) {
        log(`[telegram-channel] Reached beginning of channel`);
        break;
      }
    }

    await browser.close();

    // Trim to requested max
    const messages = allMessages.slice(0, maxMessages);

    // Find continuation cursor (oldest message ID)
    const oldestMessageId = messages.length > 0
      ? Math.min(...messages.map((m) => m.messageId))
      : null;

    emitResult({
      channel: channelInfo,
      messages,
      meta: {
        fetched: messages.length,
        requestedMax: maxMessages,
        hasMore: nextBeforeId !== null || allMessages.length > maxMessages,
        nextBeforeId: nextBeforeId || (oldestMessageId ? oldestMessageId - 1 : null),
        pagesLoaded: pageCount,
      },
    });
  } catch (err) {
    await browser.close().catch(() => {});
    log(`[telegram-channel] Error: ${err.message}`);
    emitError("UNEXPECTED_ERROR", err.message);
  }
}

main().catch((err) => {
  emitError("FATAL", err.message);
});
