import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { TaskPackLoader } from '@showrun/core';

vi.mock('@showrun/mcp-server', () => ({
  discoverPacks: vi.fn(),
}));

import { discoverPacks } from '@showrun/mcp-server';
import { TaskPackEditorWrapper } from '../mcpWrappers.js';

describe('TaskPackEditorWrapper conversion', () => {
  let testDir: string;
  let workspaceDir: string;
  let packDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `showrun-mcp-wrapper-${randomBytes(8).toString('hex')}`);
    workspaceDir = join(testDir, 'workspace');
    packDir = join(workspaceDir, 'legacy-pack');
    mkdirSync(packDir, { recursive: true });

    writeFileSync(join(packDir, 'taskpack.json'), JSON.stringify({
      id: 'legacy-pack',
      name: 'Legacy Pack',
      version: '0.1.0',
      description: 'Legacy JSON-DSL pack',
      kind: 'json-dsl',
    }, null, 2));

    writeFileSync(join(packDir, 'flow.json'), JSON.stringify({
      inputs: {
        query: { type: 'string', required: true },
      },
      collectibles: [
        { name: 'title', type: 'string' },
      ],
      flow: [
        { id: 'step-1', type: 'navigate', params: { url: 'https://example.com' } },
      ],
    }, null, 2));

    vi.mocked(discoverPacks).mockImplementation(async () => {
      const pack = await TaskPackLoader.loadTaskPack(packDir);
      return [{ pack, path: packDir, toolName: 'legacy-pack' }] as any;
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('converts a json-dsl pack into a playwright-js scaffold', async () => {
    const wrapper = new TaskPackEditorWrapper([workspaceDir], workspaceDir, join(testDir, 'runs'));

    const result = await wrapper.convertJsonDslToPlaywrightJs('legacy-pack');

    expect(result.success).toBe(true);
    expect(result.converted).toBe(true);

    const manifest = JSON.parse(readFileSync(join(packDir, 'taskpack.json'), 'utf-8'));
    expect(manifest.kind).toBe('playwright-js');
    expect(manifest.inputs).toEqual({
      query: { type: 'string', required: true },
    });
    expect(manifest.collectibles).toEqual([
      { name: 'title', type: 'string' },
    ]);
    expect(existsSync(join(packDir, 'flow.json'))).toBe(false);
    expect(existsSync(join(packDir, 'flow.playwright.js'))).toBe(true);

    const source = readFileSync(join(packDir, 'flow.playwright.js'), 'utf-8');
    expect(source).toContain('This pack was converted from a JSON-DSL flow');
    expect(source).toContain('"type": "navigate"');
    expect(source).toContain('return {};');
  });
});
