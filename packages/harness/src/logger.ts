import { mkdirSync } from 'fs';
import { join } from 'path';
import winston from 'winston';
import type { Logger, LogEvent } from '@showrun/core';

/**
 * Custom Winston format that transforms log info to match our LogEvent structure
 * Output format: { timestamp, type, data }
 * Uses a transform function to restructure Winston's log format
 */
const logEventFormat = winston.format((info) => {
  // Extract type and data from metadata (we pass these when calling logger.info)
  const { level, message, timestamp, splat, type, ...rest } = info;
  
  // The type is passed both as message and in metadata, prefer metadata.type
  const eventType = type || message;
  
  // All remaining fields in rest are the event data
  const eventData = rest;
  
  // Clear the info object and rebuild with only our structure
  Object.keys(info).forEach(key => delete (info as any)[key]);
  
  // Set our custom structure: { timestamp, type, data }
  (info as any).timestamp = timestamp || new Date().toISOString();
  (info as any).type = eventType;
  (info as any).data = eventData;
  
  return info;
});

/**
 * JSONL file logger using Winston
 * Writes structured log events as JSONL (one JSON object per line)
 */
export class JSONLLogger implements Logger {
  private logger: winston.Logger;

  constructor(runsDir: string) {
    // Ensure directory exists
    mkdirSync(runsDir, { recursive: true });

    const logPath = join(runsDir, 'events.jsonl');

    // Create Winston logger with JSONL format
    // Custom format transforms Winston's log structure to match our LogEvent format
    // winston.format.json() serializes to JSON, File transport writes one line per log (JSONL)
    this.logger = winston.createLogger({
      level: 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        logEventFormat(),
        winston.format.json()
      ),
      transports: [
        new winston.transports.File({
          filename: logPath,
          options: { flags: 'a' }, // Append mode for JSONL
        }),
      ],
      // Don't log to console, only to file
      silent: false,
    });
  }

  log(event: LogEvent): void {
    // Pass event type as message and include type + data in metadata
    // The custom format will transform this to { timestamp, type, data }
    this.logger.info(event.type, {
      type: event.type,
      ...event.data,
    });
  }
}
