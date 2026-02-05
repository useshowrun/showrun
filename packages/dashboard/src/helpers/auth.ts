import type { Request } from 'express';

/**
 * Creates a token checker function bound to a session token
 */
export function createTokenChecker(sessionToken: string) {
  return function requireToken(req: Request): boolean {
    const token = req.headers['x-showrun-token'];
    return token === sessionToken;
  };
}
