/**
 * Tests for the two-agent architecture: tool splitting and editor agent behavior.
 */

import { describe, it, expect } from 'vitest';
import {
  EXPLORATION_AGENT_TOOLS,
  EDITOR_AGENT_TOOLS,
  MAIN_AGENT_TOOL_DEFINITIONS,
  MCP_AGENT_TOOL_DEFINITIONS,
} from '../../agentTools.js';

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

  it('EDITOR_AGENT_TOOLS contains only editor tools', () => {
    const names = EDITOR_AGENT_TOOLS.map(t => t.function.name);
    expect(names).toContain('editor_read_pack');
    expect(names).toContain('editor_list_secrets');
    expect(names).toContain('editor_apply_flow_patch');
    expect(names).toContain('editor_run_pack');
    expect(names).not.toContain('editor_validate_flow');
    expect(names).toHaveLength(4);
  });

  it('EDITOR_AGENT_TOOLS does NOT contain browser or conversation tools', () => {
    const names = EDITOR_AGENT_TOOLS.map(t => t.function.name);
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
    // Editor tools should all be in master
    for (const tool of EDITOR_AGENT_TOOLS) {
      expect(masterNames.has(tool.function.name)).toBe(true);
    }
    // Exploration tools should be in master (except agent_build_flow which is new)
    for (const tool of EXPLORATION_AGENT_TOOLS) {
      if (tool.function.name === 'agent_build_flow') continue;
      expect(masterNames.has(tool.function.name)).toBe(true);
    }
  });
});
