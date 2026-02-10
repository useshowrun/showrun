import { describe, it, expect } from 'vitest';
import { parsePlaywrightError } from '../agentTools.js';

describe('parsePlaywrightError', () => {
  it('parses click timeout with intercepted click (element found, click attempted)', () => {
    const raw =
      "locator.click: Timeout 30000ms exceeded.\nCall log:\n\u001b[2m  - waiting for getByText('Summer 2026', { exact: true }).first()\u001b[22m\n\u001b[2m  - locator resolved to <span class=\"_label_zhfs4_241\">Summer 2026</span>\u001b[22m\n\u001b[2m  - attempting click action\u001b[22m\n\u001b[2m    - waiting for element to be visible, enabled and stable\u001b[22m\n\u001b[2m    - element is visible, enabled and stable\u001b[22m\n\u001b[2m    - scrolling into view if needed\u001b[22m\n\u001b[2m    - done scrolling\u001b[22m\n\u001b[2m    - performing click action\u001b[22m\n";

    const result = parsePlaywrightError(raw);

    expect(result.error).toBe('locator.click: Timeout 30000ms exceeded.');
    expect(result.hint).toContain('intercepted');
    expect(result.hint).toContain('browser_click_coordinates');
    expect(result.callLog).toBeDefined();
    expect(result.callLog!.length).toBeGreaterThan(0);
    expect(result.callLog).toContain("locator resolved to <span class=\"_label_zhfs4_241\">Summer 2026</span>");
  });

  it('parses timeout when element not found', () => {
    const raw =
      "locator.click: Timeout 30000ms exceeded.\nCall log:\n\u001b[2m  - waiting for getByRole('button', { name: 'Submit' })\u001b[22m\n";

    const result = parsePlaywrightError(raw);

    expect(result.error).toBe('locator.click: Timeout 30000ms exceeded.');
    expect(result.hint).toContain('not found');
  });

  it('parses timeout when element found but not visible', () => {
    const raw =
      "locator.click: Timeout 30000ms exceeded.\nCall log:\n\u001b[2m  - waiting for getByText('Hidden Button')\u001b[22m\n\u001b[2m  - locator resolved to <button style=\"display:none\">Hidden Button</button>\u001b[22m\n\u001b[2m  - attempting click action\u001b[22m\n\u001b[2m    - waiting for element to be visible, enabled and stable\u001b[22m\n";

    const result = parsePlaywrightError(raw);

    expect(result.error).toBe('locator.click: Timeout 30000ms exceeded.');
    expect(result.hint).toContain('not visible');
  });

  it('parses strict mode violation', () => {
    const raw = "locator.click: Error: strict mode violation: getByText('Click me') resolved to 3 elements";

    const result = parsePlaywrightError(raw);

    expect(result.hint).toContain('3');
    expect(result.hint).toContain('more specific');
  });

  it('parses element detached from DOM', () => {
    const raw = "locator.click: Error: element is not attached to the DOM";

    const result = parsePlaywrightError(raw);

    expect(result.hint).toContain('removed from the DOM');
    expect(result.hint).toContain('wait_for');
  });

  it('parses frame detached error', () => {
    const raw = "locator.click: Error: frame was detached";

    const result = parsePlaywrightError(raw);

    expect(result.hint).toContain('navigation');
  });

  it('returns plain error for unknown patterns', () => {
    const raw = "Some random error message";

    const result = parsePlaywrightError(raw);

    expect(result.error).toBe('Some random error message');
    expect(result.hint).toBeUndefined();
    expect(result.callLog).toBeUndefined();
  });

  it('strips ANSI codes from error message', () => {
    const raw = "\u001b[2mlocator.click: Timeout\u001b[22m";

    const result = parsePlaywrightError(raw);

    expect(result.error).not.toContain('\u001b');
    expect(result.error).toBe('locator.click: Timeout');
  });
});
