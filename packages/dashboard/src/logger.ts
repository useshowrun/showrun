import { mkdirSync } from 'fs';
import { join } from 'path';
import winston from 'winston';
import type { Server as SocketIOServer } from 'socket.io';
import type { Logger, LogEvent } from '@showrun/core';

/**
 * Custom Winston format that transforms log info to match our LogEvent structure
 */
const logEventFormat = winston.format((info) => {
  const { level, message, timestamp, splat, type, ...rest } = info;
  const eventType = type || message;
  const eventData = rest;

  Object.keys(info).forEach((key) => delete (info as any)[key]);

  (info as any).timestamp = timestamp || new Date().toISOString();
  (info as any).type = eventType;
  (info as any).data = eventData;

  return info;
});

/**
 * Logger that writes to JSONL file AND emits socket events in real time
 */
export class SocketLogger implements Logger {
  private logger: winston.Logger;
  private io: SocketIOServer;
  private runId: string;

  constructor(runDir: string, io: SocketIOServer, runId: string) {
    // Ensure directory exists
    mkdirSync(runDir, { recursive: true });

    const logPath = join(runDir, 'events.jsonl');

    // Create Winston logger with JSONL format
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
      silent: false,
    });

    this.io = io;
    this.runId = runId;
  }

  log(event: LogEvent): void {
    // Write to JSONL file
    this.logger.info(event.type, {
      type: event.type,
      ...event.data,
    });

    // Emit socket event in real time
    this.io.emit(`runs:events:${this.runId}`, {
      timestamp: new Date().toISOString(),
      type: event.type,
      data: event.data,
    });
  }
}
