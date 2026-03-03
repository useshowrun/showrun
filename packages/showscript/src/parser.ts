import type { Program, SourceLocation } from "./ast.js";

// The generated parser is a JS file produced by `peggy --format es`
// @ts-ignore - generated file
import * as generatedParser from "./generated-parser.js";

const peggyParse = (generatedParser as { parse: Function }).parse;

export interface ParseOptions {
  /** Include source location info on AST nodes (default: true) */
  locations?: boolean;
  /** Filename for error messages */
  filename?: string;
}

export interface ParseError {
  message: string;
  location?: SourceLocation;
  filename?: string;
}

export class ShowScriptSyntaxError extends Error {
  location?: SourceLocation;
  filename?: string;

  constructor(message: string, location?: SourceLocation, filename?: string) {
    const loc = location?.start;
    const prefix = filename ? `${filename}:` : "";
    const locStr = loc ? `${prefix}${loc.line}:${loc.column}: ` : "";
    super(`${locStr}${message}`);
    this.name = "ShowScriptSyntaxError";
    this.location = location;
    this.filename = filename;
  }
}

/**
 * Parse a ShowScript source string into an AST.
 */
export function parse(source: string, options?: ParseOptions): Program {
  try {
    const ast = peggyParse(source, {
      grammarSource: options?.filename,
    }) as Program;
    return ast;
  } catch (err: any) {
    if (err.location) {
      throw new ShowScriptSyntaxError(
        err.message,
        err.location,
        options?.filename,
      );
    }
    throw err;
  }
}
