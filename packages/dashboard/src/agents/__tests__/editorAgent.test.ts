/**
 * Tests for the two-agent architecture: tool splitting and editor agent behavior.
 */

import { describe, it, expect } from 'vitest';
import {
  EXPLORATION_AGENT_TOOLS,
  EDITOR_JSON_DSL_TOOLS,
  EDITOR_PLAYWRIGHT_JS_TOOLS,
  EDITOR_AGENT_TOOLS,
  MAIN_AGENT_TOOL_DEFINITIONS,
  MCP_AGENT_TOOL_DEFINITIONS,
  getEditorToolsForPackKind,
} from '../../agentTools.js';
import { getEditorAgentConfigForPackKind } from '../editorAgent.js';

describe('Tool Definitions Split', () => {
  it('EXPLORATION_AGENT_TOOLS contains browser tools', () => {
    const names = EXPLORATION_AGENT_TOOLS.map(t => t.function.name);
    expect(names).toContain('browser_goto');
    expect(names).toContain('browser_screenshot');
    expect(names).toContain('browser_click');
    expect(names).toContain('browser_get_dom_snapshot');
    expect(names).toContain('browser_network_list');
    expect(names).toContain('browser_network_search');
    expect(names).toContain('browser_network_replay');
  });

  it('EXPLORATION_AGENT_TOOLS contains context/conversation tools', () => {
    const names = EXPLORATION_AGENT_TOOLS.map(t => t.function.name);
    expect(names).toContain('agent_save_plan');
    expect(names).toContain('agent_get_plan');
    expect(names).toContain('conversation_update_title');
    expect(names).toContain('conversation_update_description');
    expect(names).toContain('conversation_set_status');
  });

  it('EXPLORATION_AGENT_TOOLS contains agent_build_flow', () => {
    const names = EXPLORATION_AGENT_TOOLS.map(t => t.function.name);
    expect(names).toContain('agent_build_flow');
  });

  it('EXPLORATION_AGENT_TOOLS contains editor_read_pack (read-only)', () => {
    const names = EXPLORATION_AGENT_TOOLS.map(t => t.function.name);
    expect(names).toContain('editor_read_pack');
  });

  it('EXPLORATION_AGENT_TOOLS contains request_secrets', () => {
    const names = EXPLORATION_AGENT_TOOLS.map(t => t.function.name);
    expect(names).toContain('request_secrets');
  });

  it('EXPLORATION_AGENT_TOOLS does NOT contain editor write tools', () => {
    const names = EXPLORATION_AGENT_TOOLS.map(t => t.function.name);
    expect(names).not.toContain('editor_apply_flow_patch');
    expect(names).not.toContain('editor_validate_flow');
    expect(names).not.toContain('editor_run_pack');
    expect(names).not.toContain('editor_create_pack');
  });

  it('EDITOR_JSON_DSL_TOOLS contains only json-dsl editor tools', () => {
    const names = EDITOR_JSON_DSL_TOOLS.map(t => t.function.name);
    expect(names).toContain('editor_read_pack');
    expect(names).toContain('editor_list_secrets');
    expect(names).toContain('editor_apply_flow_patch');
    expect(names).toContain('editor_validate_flow');
    expect(names).toContain('editor_run_pack');
    expect(names).not.toContain('editor_write_js');
    expect(names).toHaveLength(5);
  });

  it('EDITOR_PLAYWRIGHT_JS_TOOLS contains only playwright-js editor tools', () => {
    const names = EDITOR_PLAYWRIGHT_JS_TOOLS.map(t => t.function.name);
    expect(names).toContain('editor_read_pack');
    expect(names).toContain('editor_list_secrets');
    expect(names).toContain('editor_write_js');
    expect(names).toContain('editor_run_pack');
    expect(names).not.toContain('editor_apply_flow_patch');
    expect(names).not.toContain('editor_validate_flow');
    expect(names).toHaveLength(4);
  });

  it('editor toolsets do NOT contain browser or conversation tools', () => {
    const names = [...EDITOR_JSON_DSL_TOOLS, ...EDITOR_PLAYWRIGHT_JS_TOOLS].map(t => t.function.name);
    expect(names).not.toContain('browser_goto');
    expect(names).not.toContain('browser_screenshot');
    expect(names).not.toContain('conversation_set_status');
    expect(names).not.toContain('agent_save_plan');
    expect(names).not.toContain('agent_build_flow');
    expect(names).not.toContain('request_secrets');
  });

  it('agent_build_flow has correct parameter schema', () => {
    const buildFlowTool = EXPLORATION_AGENT_TOOLS.find(t => t.function.name === 'agent_build_flow');
    expect(buildFlowTool).toBeDefined();
    const params = buildFlowTool!.function.parameters;
    expect(params.properties).toHaveProperty('instruction');
    expect(params.properties).toHaveProperty('explorationContext');
    expect(params.properties).toHaveProperty('testInputs');
    expect(params.required).toContain('instruction');
    expect(params.required).toContain('explorationContext');
    expect(params.required).not.toContain('testInputs');
  });

  it('MAIN_AGENT_TOOL_DEFINITIONS still exists for backward compat', () => {
    expect(MAIN_AGENT_TOOL_DEFINITIONS.length).toBeGreaterThan(0);
    // Should not include initializer-only tools
    const names = MAIN_AGENT_TOOL_DEFINITIONS.map(t => t.function.name);
    expect(names).not.toContain('editor_create_pack');
    expect(names).not.toContain('conversation_link_pack');
  });

  it('all tool definitions in splits come from MCP_AGENT_TOOL_DEFINITIONS or are new', () => {
    const masterNames = new Set(MCP_AGENT_TOOL_DEFINITIONS.map(t => t.function.name));
    for (const tool of EDITOR_JSON_DSL_TOOLS) {
      expect(masterNames.has(tool.function.name)).toBe(true);
    }
    for (const tool of EDITOR_PLAYWRIGHT_JS_TOOLS) {
      expect(masterNames.has(tool.function.name)).toBe(true);
    }
    // Exploration tools should be in master (except agent_build_flow, agent_validate_flow, and techniques_* which are defined separately)
    for (const tool of EXPLORATION_AGENT_TOOLS) {
      if (tool.function.name === 'agent_build_flow') continue;
      if (tool.function.name === 'agent_validate_flow') continue;
      if (tool.function.name.startsWith('techniques_')) continue;
      expect(masterNames.has(tool.function.name)).toBe(true);
    }
  });

  it('getEditorToolsForPackKind selects the correct toolset', () => {
    expect(getEditorToolsForPackKind('json-dsl').map(t => t.function.name)).toEqual(
      EDITOR_JSON_DSL_TOOLS.map(t => t.function.name)
    );
    expect(getEditorToolsForPackKind('playwright-js').map(t => t.function.name)).toEqual(
      EDITOR_PLAYWRIGHT_JS_TOOLS.map(t => t.function.name)
    );
    expect(EDITOR_AGENT_TOOLS.map(t => t.function.name)).toEqual(
      EDITOR_PLAYWRIGHT_JS_TOOLS.map(t => t.function.name)
    );
  });

  it('getEditorAgentConfigForPackKind selects prompt and tools by pack kind', () => {
    const dsl = getEditorAgentConfigForPackKind('json-dsl');
    const js = getEditorAgentConfigForPackKind('playwright-js');

    expect(dsl.tools.map(t => t.function.name)).toEqual(EDITOR_JSON_DSL_TOOLS.map(t => t.function.name));
    expect(js.tools.map(t => t.function.name)).toEqual(EDITOR_PLAYWRIGHT_JS_TOOLS.map(t => t.function.name));
    expect(dsl.systemPrompt).toContain('JSON-DSL');
    expect(js.systemPrompt).toContain('Playwright JS');
  });
});
