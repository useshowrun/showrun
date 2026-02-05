import type { TaskPack } from '@showrun/core';
import { navigate, waitFor, extractTitle, extractText, assert } from '@showrun/core';

const taskPack: TaskPack = {
  metadata: {
    id: 'example.site.collector',
    name: 'Example Collector',
    version: '0.1.0',
    description: 'Demo task pack that navigates to example.com and extracts page title and h1 text',
  },
  inputs: {
    // No inputs required for this example
  },
  collectibles: [
    {
      name: 'page_title',
      type: 'string',
      description: 'The page title from the <title> tag',
    },
    {
      name: 'h1_text',
      type: 'string',
      description: 'The text content of the first <h1> element',
    },
  ],
  // Declarative DSL flow - deterministic, AI-free at runtime
  flow: [
    navigate('navigate', {
      url: 'https://example.com',
      waitUntil: 'networkidle',
      label: 'Navigate to example.com',
    }),
    waitFor('wait_for_h1', {
      selector: 'h1',
      visible: true,
      label: 'Wait for h1 element to be visible',
      timeoutMs: 5000,
    }),
    assert('assert_h1_exists', {
      selector: 'h1',
      visible: true,
      label: 'Verify h1 element exists',
    }),
    extractTitle('extract_title', {
      out: 'page_title',
      label: 'Extract page title',
    }),
    extractText('extract_h1', {
      selector: 'h1',
      out: 'h1_text',
      first: true,
      trim: true,
      label: 'Extract h1 text',
    }),
  ],
};

export default taskPack;
