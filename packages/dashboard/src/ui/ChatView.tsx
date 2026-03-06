import React, { useState, useEffect, useRef } from 'react';
import MessageBubble, { type ToolCall } from './MessageBubble.js';
import ChatInput from './ChatInput.js';
import SecretsPanel from './SecretsPanel.js';
import SecretsRequestModal from './SecretsRequestModal.js';
import VersionPanel from './VersionPanel.js';
import McpUsageModal from './McpUsageModal.js';
import { parseCommand, findCommand, COMMAND_REGISTRY, type CommandContext } from './chatCommands.js';
import { ShowRunLogo } from './ShowRunLogo.js';

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolCalls?: string | null; // JSON string
  thinkingContent?: string | null;
  createdAt: number;
}

export interface Conversation {
  id: string;
  title: string;
  description: string | null;
  status: 'active' | 'ready' | 'needs_input' | 'error';
  packId: string | null;
  createdAt: number;
  updatedAt: number;
  messages?: Message[];
}

interface ToolTraceEntry {
  tool: string;
  args: unknown;
  result: unknown;
  success: boolean;
}

interface NetworkEntry {
  id: string;
  ts: number;
  method: string;
  url: string;
  status?: number;
  isLikelyApi?: boolean;
}

interface ChatViewProps {
  conversation: Conversation | null;
  token: string;
  packs?: Array<{ id: string; path: string; name: string }>;
  onConversationUpdate?: (updates: Partial<Conversation>) => void;
  onNewMessage?: (message: Message) => void;
  onCreateConversationWithPack?: (packId: string) => Promise<void>;
}

export default function ChatView({
  conversation,
  token,
  packs,
  onConversationUpdate,
  onNewMessage,
  onCreateConversationWithPack,
}: ChatViewProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Browser session state
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [screenshot, setScreenshot] = useState<string | null>(null);

  // Tool trace for current request
  const [toolTrace, setToolTrace] = useState<ToolTraceEntry[]>([]);
  const [activeToolExecution, setActiveToolExecution] = useState<{
    tool: string;
    args: unknown;
    startedAt: number;
  } | null>(null);

  // Streaming state
  const [streamingThinking, setStreamingThinking] = useState('');
  const [streamingContent, setStreamingContent] = useState('');
  const [isThinking, setIsThinking] = useState(false);
  const [isSummarizing, setIsSummarizing] = useState(false);

  // UI state
  const [showNetwork, setShowNetwork] = useState(true);
  const [rightPanelTab, setRightPanelTab] = useState<'network' | 'secrets' | 'versions' | 'run' | 'research'>('network');
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  const [panelAutoCollapsed, setPanelAutoCollapsed] = useState(false);

  // Flow input schema + run form state
  const [flowInputSchema, setFlowInputSchema] = useState<Record<string, { type: string; required?: boolean; description?: string; default?: unknown }> | null>(null);
  const [runInputValues, setRunInputValues] = useState<Record<string, string | number | boolean>>({});

  // Secrets request modal state (AI-triggered)
  const [secretsRequest, setSecretsRequest] = useState<{
    secrets: Array<{ name: string; description?: string; required?: boolean }>;
    message: string;
    packId?: string; // packId from streaming event, in case conversation.packId hasn't synced yet
  } | null>(null);

  // MCP Usage modal
  const [showMcpUsage, setShowMcpUsage] = useState(false);

  // Research agent state
  const [researchPrompt, setResearchPrompt] = useState('');
  const [researchLoading, setResearchLoading] = useState(false);
  const [researchResult, setResearchResult] = useState<{
    totalTechniquesFound: number;
    searchQueries: string[];
    techniqueGroups: Array<{ category: string; techniques: Array<{ title: string; priority: number }> }>;
  } | null>(null);

  // Network requests
  const [networkRequests, setNetworkRequests] = useState<NetworkEntry[]>([]);
  const [networkLoading, setNetworkLoading] = useState(false);

  // Resizable right panel
  const [rightPanelWidth, setRightPanelWidth] = useState(380);
  const rightPanelIsResizing = useRef(false);
  const rightPanelStartX = useRef(0);
  const rightPanelStartWidth = useRef(0);

  const handleRightPanelResizeStart = (e: React.MouseEvent) => {
    rightPanelIsResizing.current = true;
    rightPanelStartX.current = e.clientX;
    rightPanelStartWidth.current = rightPanelWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!rightPanelIsResizing.current) return;
      const delta = rightPanelStartX.current - e.clientX;
      const newWidth = Math.min(600, Math.max(240, rightPanelStartWidth.current + delta));
      setRightPanelWidth(newWidth);
    };
    const onMouseUp = () => {
      if (rightPanelIsResizing.current) {
        rightPanelIsResizing.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  // Refs
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Refs to capture streaming state for error handling
  const streamingThinkingRef = useRef('');
  const streamingContentRef = useRef('');
  const toolTraceRef = useRef<ToolTraceEntry[]>([]);

  // Load conversation messages when conversation changes
  useEffect(() => {
    if (conversation?.messages) {
      setMessages(conversation.messages);
    } else if (conversation?.id) {
      loadMessages(conversation.id);
    } else {
      setMessages([]);
    }
  }, [conversation?.id]);

  // Clear secrets request state when conversation changes to prevent modal from showing with wrong packId
  useEffect(() => {
    setSecretsRequest(null);
  }, [conversation?.id]);

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent]);

  // Fetch flow input schema when pack changes
  useEffect(() => {
    if (!conversation?.packId) { setFlowInputSchema(null); return; }
    fetch(`/api/packs/${conversation.packId}/files`, {
      headers: { 'Content-Type': 'application/json', 'x-showrun-token': token },
    })
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        const inputs = data?.flowJson?.inputs ?? null;
        setFlowInputSchema(inputs);
        // Pre-fill default values
        if (inputs) {
          const defaults: Record<string, string | number | boolean> = {};
          for (const [key, schema] of Object.entries(inputs) as [string, { type: string; default?: unknown }][]) {
            if (schema.default !== undefined) {
              defaults[key] = schema.default as string | number | boolean;
            }
          }
          setRunInputValues(defaults);
        } else {
          setRunInputValues({});
        }
      })
      .catch(() => setFlowInputSchema(null));
  }, [conversation?.packId]);

  // Auto-collapse right panel on small screens
  useEffect(() => {
    const mql = window.matchMedia('(max-width: 900px)');
    const handler = (e: MediaQueryListEvent | MediaQueryList) => {
      if (e.matches) {
        setPanelAutoCollapsed(true);
        setRightPanelOpen(false);
      } else if (panelAutoCollapsed) {
        setPanelAutoCollapsed(false);
        setRightPanelOpen(true);
      }
    };
    handler(mql);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [panelAutoCollapsed]);

  // Load network requests when session changes
  useEffect(() => {
    if (sessionId) {
      loadNetworkRequests();
    } else {
      setNetworkRequests([]);
    }
  }, [sessionId]);

  const apiCall = async (endpoint: string, options: RequestInit = {}) => {
    const response = await fetch(endpoint, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'x-showrun-token': token,
        ...options.headers,
      },
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(errorData.error || `HTTP ${response.status}`);
    }

    return response.json();
  };

  const loadMessages = async (conversationId: string) => {
    try {
      const data = await apiCall(`/api/conversations/${conversationId}/messages`);
      setMessages(data);
    } catch (err) {
      console.error('Failed to load messages:', err);
    }
  };

  const loadNetworkRequests = async () => {
    if (!sessionId) return;
    setNetworkLoading(true);
    try {
      const list = await apiCall('/api/teach/browser/network-list', {
        method: 'POST',
        body: JSON.stringify({ sessionId, limit: 30, filter: 'all' }),
      });
      setNetworkRequests(Array.isArray(list) ? list : []);
    } catch {
      setNetworkRequests([]);
    } finally {
      setNetworkLoading(false);
    }
  };

  const handleStartSession = async () => {
    try {
      setIsLoading(true);
      setError(null);
      const result = await apiCall('/api/teach/browser/start', {
        method: 'POST',
        body: JSON.stringify({ headful: true }),
      });
      setSessionId(result.sessionId);
      // Take initial screenshot
      const screenshotResult = await apiCall('/api/teach/browser/screenshot', {
        method: 'POST',
        body: JSON.stringify({ sessionId: result.sessionId }),
      });
      const mime = screenshotResult.mimeType || 'image/png';
      setScreenshot(`data:${mime};base64,${screenshotResult.imageBase64}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  };

  const addSystemMessage = (content: string) => {
    const msg: Message = {
      id: `sys-${Date.now()}`,
      role: 'system',
      content,
      createdAt: Date.now(),
    };
    setMessages((prev) => [...prev, msg]);
  };

  const handleSend = async () => {
    const text = inputValue.trim();
    if (!text || isLoading || !conversation) return;

    // --- Slash command interception ---
    const parsed = parseCommand(text);
    if (parsed) {
      const cmd = findCommand(parsed.command);
      if (cmd) {
        // Show the user's command in chat (ephemeral, not saved to DB)
        const userMsg: Message = {
          id: `cmd-${Date.now()}`,
          role: 'user',
          content: text,
          createdAt: Date.now(),
        };
        setMessages((prev) => [...prev, userMsg]);
        setInputValue('');

        const cmdCtx: CommandContext = {
          conversation: conversation ? {
            id: conversation.id,
            title: conversation.title,
            packId: conversation.packId,
            status: conversation.status,
          } : null,
          token,
          messages,
          addSystemMessage,
          setMessages,
          onCreateConversation: onCreateConversationWithPack || (async () => {}),
        };

        try {
          const result = await cmd.execute(parsed.args, cmdCtx);
          if (result) {
            addSystemMessage(result);
          }
        } catch (err) {
          addSystemMessage(`Command error: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      } else {
        // Unknown command
        setInputValue('');
        const userMsg: Message = {
          id: `cmd-${Date.now()}`,
          role: 'user',
          content: text,
          createdAt: Date.now(),
        };
        setMessages((prev) => [...prev, userMsg]);
        addSystemMessage(`Unknown command \`/${parsed.command}\`. Type **/help** to see available commands.`);
        return;
      }
    }

    const userMessage: Message = {
      id: `temp-${Date.now()}`,
      role: 'user',
      content: text,
      createdAt: Date.now(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInputValue('');
    setIsLoading(true);
    setError(null);
    setToolTrace([]);
    setActiveToolExecution(null);
    setStreamingThinking('');
    setStreamingContent('');
    setIsThinking(false);
    // Reset refs for fresh start
    streamingThinkingRef.current = '';
    streamingContentRef.current = '';
    toolTraceRef.current = [];

    // Save user message to database
    try {
      await apiCall(`/api/conversations/${conversation.id}/messages`, {
        method: 'POST',
        body: JSON.stringify({ role: 'user', content: text }),
      });
    } catch (err) {
      console.error('Failed to save user message:', err);
    }

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      const messagesForApi = messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .concat(userMessage)
        .map((m) => ({
          role: m.role,
          content: m.content,
        }));

      const response = await fetch('/api/teach/agent', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-showrun-token': token,
        },
        body: JSON.stringify({
          messages: messagesForApi,
          packId: conversation.packId || null,
          browserSessionId: sessionId || null,
          conversationId: conversation.id,
          stream: true,
          systemPromptOverride: researchPrompt || null,
        }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('Streaming not supported');

      const decoder = new TextDecoder();
      let buffer = '';
      let result: {
        assistantMessage?: { content?: string };
        toolTrace?: ToolTraceEntry[];
        browser?: { screenshotBase64?: string; mimeType?: string };
        browserSessionId?: string;
        error?: string;
      } = {};

      const processLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          const obj = JSON.parse(trimmed);
          console.log('[ChatView] Stream event:', obj.type || 'unknown', obj);

          if (obj.type === 'thinking_start') {
            setIsThinking(true);
            setStreamingThinking('');
            streamingThinkingRef.current = '';
          } else if (obj.type === 'thinking_delta' && obj.text) {
            setStreamingThinking((prev) => {
              const newVal = prev + obj.text;
              streamingThinkingRef.current = newVal;
              return newVal;
            });
          } else if (obj.type === 'thinking_stop') {
            setIsThinking(false);
          } else if (obj.type === 'content_start') {
            setStreamingContent('');
            streamingContentRef.current = '';
          } else if (obj.type === 'content_delta' && obj.text) {
            setStreamingContent((prev) => {
              const newVal = prev + obj.text;
              streamingContentRef.current = newVal;
              return newVal;
            });
          } else if (obj.type === 'content_stop') {
            // Content finished streaming
          } else if (obj.type === 'tool_start') {
            setActiveToolExecution({
              tool: obj.tool!,
              args: obj.args,
              startedAt: Date.now(),
            });
          } else if (obj.type === 'tool_result') {
            setActiveToolExecution(null);
            const newEntry = {
              tool: obj.tool!,
              args: obj.args as Record<string, unknown>,
              result: obj.result,
              success: obj.success ?? true,
            };
            setToolTrace((prev) => {
              const newVal = [...prev, newEntry];
              toolTraceRef.current = newVal;
              return newVal;
            });
          } else if (obj.type === 'secrets_request') {
            // AI is requesting user to provide secrets
            setSecretsRequest({
              secrets: obj.secrets || [],
              message: obj.message || 'The AI agent needs some secrets to continue.',
              packId: obj.packId, // Include packId from streaming event
            });
          } else if (obj.type === 'tool_call_start') {
            // LLM is preparing a tool call (from Anthropic streaming)
            setActiveToolExecution({
              tool: obj.name || 'unknown',
              args: {},
              startedAt: Date.now(),
            });
          } else if (obj.type === 'tool_call_stop') {
            // LLM finished preparing tool call, server will execute it
            // Don't clear activeToolExecution here - wait for tool_result
          } else if (obj.type === 'research_loaded') {
            // Research agent loaded techniques — populate the Research panel
            setResearchPrompt(obj.compiledPrompt || '');
            setResearchResult({
              totalTechniquesFound: obj.totalTechniquesFound || 0,
              searchQueries: [],
              techniqueGroups: obj.techniqueGroups || [],
            });
            // Auto-open Research tab on first load
            if (!researchPrompt) {
              setRightPanelTab('research');
              setRightPanelOpen(true);
            }
          } else if (obj.type === 'summarizing') {
            setIsSummarizing(true);
          } else if (obj.type === 'summarized') {
            setIsSummarizing(false);
          } else if (obj.type === 'done') {
            setActiveToolExecution(null);
            result = obj;
          } else if (obj.error) {
            // Handle error object in stream
            console.error('[ChatView] Stream error:', obj.error);
            result = { error: obj.error };
          }
        } catch (e) {
          // Log parse errors for debugging (could be HTML error page or malformed JSON)
          console.warn('[ChatView] Failed to parse stream line:', trimmed.slice(0, 200), e);
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) processLine(line);
      }
      for (const line of buffer.split('\n')) processLine(line);

      // Add assistant message to local state for immediate display
      const assistantContent = result.assistantMessage?.content ?? result.error ?? '';
      const finalToolTrace = toolTrace.length > 0 ? toolTrace : result.toolTrace;
      const assistantMessage: Message = {
        id: `temp-${Date.now()}`,
        role: 'assistant',
        content: assistantContent,
        toolCalls: finalToolTrace ? JSON.stringify(finalToolTrace) : null,
        thinkingContent: streamingThinking || null,
        createdAt: Date.now(),
      };
      setMessages((prev) => [...prev, assistantMessage]);

      // Backend saves assistant message with rich agentContext — reload from DB for canonical state
      await loadMessages(conversation.id);

      // Update browser state
      if (result.browser?.screenshotBase64) {
        const mime = result.browser.mimeType || 'image/png';
        setScreenshot(`data:${mime};base64,${result.browser.screenshotBase64}`);
      }
      if (result.browserSessionId && !sessionId) {
        setSessionId(result.browserSessionId);
      }
      if (result.error) {
        setError(result.error);
      }
    } catch (err) {
      // Capture streaming state from refs before finally clears them
      const capturedThinking = streamingThinkingRef.current;
      const capturedContent = streamingContentRef.current;
      const capturedToolTrace = [...toolTraceRef.current];

      const isAbort = err instanceof Error && err.name === 'AbortError';
      const errorContent = isAbort
        ? '(Stopped by user)'
        : `Error: ${err instanceof Error ? err.message : String(err)}`;

      // Build message with captured data for immediate display
      const finalContent = capturedContent || errorContent;
      const assistantMessage: Message = {
        id: `temp-${Date.now()}`,
        role: 'assistant',
        content: finalContent,
        toolCalls: capturedToolTrace.length > 0 ? JSON.stringify(capturedToolTrace) : null,
        thinkingContent: capturedThinking || null,
        createdAt: Date.now(),
      };
      setMessages((prev) => [...prev, assistantMessage]);

      // On abort: do NOT reload from DB — the backend save is async and races with us.
      // The locally-constructed partial message above is the best state we have.
      // On non-abort errors: also keep local state since backend may not have saved.

      if (!isAbort) {
        setError(err instanceof Error ? err.message : String(err));
      }
      setActiveToolExecution(null);
    } finally {
      setIsLoading(false);
      setActiveToolExecution(null);
      abortControllerRef.current = null;
      setStreamingThinking('');
      setStreamingContent('');
      setIsThinking(false);
      setIsSummarizing(false);
      // Reset refs
      streamingThinkingRef.current = '';
      streamingContentRef.current = '';
      toolTraceRef.current = [];
    }
  };

  const handleStop = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  };

  const useRequestId = (requestId: string) => {
    setInputValue(`Use request ${requestId}`);
  };

  const handleExportConversation = async () => {
    if (!conversation) return;
    try {
      const response = await fetch(`/api/conversations/${conversation.id}/export?format=download`, {
        headers: {
          'x-showrun-token': token,
        },
      });
      if (!response.ok) {
        throw new Error(`Export failed: ${response.status}`);
      }
      // Get the filename from Content-Disposition header or use default
      const contentDisposition = response.headers.get('Content-Disposition');
      let filename = `conversation-debug-${conversation.id.slice(0, 8)}.json`;
      if (contentDisposition) {
        const match = contentDisposition.match(/filename="(.+)"/);
        if (match) filename = match[1];
      }
      // Download the file
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Export failed:', err);
      setError(err instanceof Error ? err.message : 'Export failed');
    }
  };

  const handleRunResearch = async () => {
    if (!conversation) return;
    // Use the last user message or conversation title as the task description
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
    const taskDescription = lastUserMsg?.content || conversation.title || '';
    if (!taskDescription) return;

    setResearchLoading(true);
    setResearchResult(null);
    try {
      const result = await apiCall('/api/teach/research', {
        method: 'POST',
        body: JSON.stringify({
          taskDescription,
          domain: undefined,
          maxTechniques: 20,
        }),
      });
      if (result.success) {
        setResearchPrompt(result.compiledPrompt);
        setResearchResult({
          totalTechniquesFound: result.totalTechniquesFound,
          searchQueries: result.searchQueries,
          techniqueGroups: result.techniqueGroups,
        });
      } else {
        setResearchPrompt('');
        setError(result.error || 'Research failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setResearchLoading(false);
    }
  };

  const handleRunPack = async (inputs: Record<string, unknown> = {}) => {
    if (!conversation?.packId) return;
    try {
      setError(null);
      await apiCall('/api/runs', {
        method: 'POST',
        body: JSON.stringify({
          packId: conversation.packId,
          inputs,
          conversationId: conversation.id,
          source: 'dashboard',
        }),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (!conversation) {
    return (
      <div className="welcome-screen">
        <div className="welcome-logo"><ShowRunLogo size="xl" /></div>
        <div className="welcome-subtitle">
          Create browser automation flows through conversation. Select a conversation or start a new chat.
        </div>
      </div>
    );
  }

  return (
    <div className="chat-container">
      {/* CSS for spinner animation */}
      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>

      {/* Conversation header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '12px 16px',
        borderBottom: '1px solid var(--border-subtle)',
        backgroundColor: 'var(--bg-sidebar)',
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', flex: 1, minWidth: 0 }}>
          <div style={{
            fontWeight: 600,
            fontSize: '14px',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}>
            {conversation.title}
          </div>
          {conversation.packId && (
            <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
              Pack: {conversation.packId}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <span style={{
            fontSize: '11px',
            padding: '2px 8px',
            borderRadius: '4px',
            backgroundColor: conversation.status === 'ready' ? 'rgba(34, 197, 94, 0.1)' :
                           conversation.status === 'error' ? 'rgba(239, 68, 68, 0.1)' :
                           'rgba(59, 130, 246, 0.1)',
            color: conversation.status === 'ready' ? 'var(--accent-green)' :
                   conversation.status === 'error' ? 'var(--accent-red)' :
                   'var(--accent-blue)',
          }}>
            {conversation.status}
          </span>
          <button
            className="btn-secondary"
            onClick={handleExportConversation}
            title="Export conversation for debugging"
            style={{ padding: '4px 10px', fontSize: '12px' }}
          >
            Export
          </button>
          {conversation.packId && (
            <button
              className="btn-secondary"
              onClick={() => setShowMcpUsage(true)}
              title="Show MCP configuration for external tools"
              style={{ padding: '4px 10px', fontSize: '12px' }}
            >
              MCP Usage
            </button>
          )}
          <button
            className="btn-secondary"
            onClick={() => { setRightPanelOpen(!rightPanelOpen); setPanelAutoCollapsed(false); }}
            title={rightPanelOpen ? 'Collapse panel' : 'Open side panel'}
            style={{ padding: '4px 8px', fontSize: '14px', lineHeight: 1 }}
          >
            {rightPanelOpen ? '\u25B6' : '\u25C0'}
          </button>
        </div>
      </div>

      {error && (
        <div className="error" style={{ margin: '16px 24px 0' }}>
          {error}
        </div>
      )}

      {/* Main chat area with side panels */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Chat messages */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div className="chat-messages">
            {messages.length === 0 && !isLoading && (
              <div className="empty-state">
                <div className="empty-state-title">Start a conversation</div>
                <div className="empty-state-description">
                  Describe what you want to automate. The AI will help you create a flow step by step.
                </div>
              </div>
            )}

            {messages.map((msg, idx) => {
              let parsedToolCalls;
              if (msg.toolCalls) {
                try {
                  parsedToolCalls = JSON.parse(msg.toolCalls);
                } catch {
                  parsedToolCalls = undefined;
                }
              }
              return (
                <MessageBubble
                  key={msg.id || idx}
                  role={msg.role}
                  content={msg.content}
                  toolCalls={parsedToolCalls}
                  thinking={msg.thinkingContent || undefined}
                />
              );
            })}

            {/* Streaming AI response */}
            {isLoading && (
              <MessageBubble
                role="assistant"
                content={streamingContent || ''}
                toolCalls={[
                  ...toolTrace.map((t): ToolCall => ({
                    tool: t.tool,
                    args: (t.args && typeof t.args === 'object' && !Array.isArray(t.args)) ? t.args as Record<string, unknown> : undefined,
                    result: t.result,
                    success: t.success,
                  })),
                  ...(activeToolExecution ? [{
                    tool: activeToolExecution.tool,
                    args: (activeToolExecution.args && typeof activeToolExecution.args === 'object' && !Array.isArray(activeToolExecution.args)) ? activeToolExecution.args as Record<string, unknown> : undefined,
                    result: '(executing...)',
                    success: true,
                  }] : []),
                ]}
                thinking={streamingThinking || (isThinking ? '...' : undefined)}
                isStreaming={true}
              />
            )}

            {/* Additional status indicators */}
            {isLoading && (
              <div style={{ alignSelf: 'flex-start', maxWidth: '85%', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {/* Summarization indicator */}
                {isSummarizing && (
                  <div style={{
                    padding: '10px 14px',
                    backgroundColor: 'rgba(255, 103, 26, 0.1)',
                    border: '1px solid rgba(255, 103, 26, 0.2)',
                    borderRadius: '8px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    color: 'var(--accent-orange)',
                    fontSize: '13px',
                  }}>
                    <span className="spinner" />
                    <span>Summarizing conversation...</span>
                  </div>
                )}

                {/* Show processing only when nothing else is happening */}
                {!streamingThinking && !isThinking && !streamingContent && !activeToolExecution && !isSummarizing && toolTrace.length === 0 && (
                  <div className="message-bubble assistant" style={{ opacity: 0.7 }}>
                    <span className="spinner" style={{ marginRight: '8px' }} />
                    Processing...
                  </div>
                )}
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          <ChatInput
            value={inputValue}
            onChange={setInputValue}
            onSend={handleSend}
            onStop={handleStop}
            isLoading={isLoading}
            placeholder="Describe what you want to automate..."
          />
        </div>

        {/* Right side panel (network / secrets / versions / run) */}
        {rightPanelOpen && (
        <>
        <div
          className="resize-handle"
          onMouseDown={handleRightPanelResizeStart}
          title=""
        />
        <div style={{
          width: rightPanelWidth,
          minWidth: rightPanelWidth,
          borderLeft: '1px solid var(--border-subtle)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          backgroundColor: 'var(--bg-sidebar)',
        }}>
          {/* Network panel */}
          {rightPanelTab === 'network' && sessionId && (
            <div className="network-panel" style={{ margin: '12px', flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <div className="network-panel-header">
                <span>Network</span>
                <button
                  className="btn-secondary"
                  style={{ padding: '4px 12px', fontSize: '12px' }}
                  onClick={loadNetworkRequests}
                  disabled={networkLoading}
                >
                  {networkLoading ? '...' : 'Refresh'}
                </button>
              </div>
              <div style={{ flex: 1, overflow: 'auto' }}>
                {networkRequests.length === 0 && !networkLoading && (
                  <div style={{ padding: '16px', color: 'var(--text-muted)', fontSize: '13px', textAlign: 'center' }}>
                    No requests yet
                  </div>
                )}
                {networkRequests.map((req) => (
                  <div key={req.id} className="network-item">
                    <span className="network-method">{req.method}</span>
                    {req.status != null && (
                      <span className={`network-status ${req.status >= 400 ? 'error' : 'success'}`}>
                        {req.status}
                      </span>
                    )}
                    <span className="network-url" title={req.url}>{req.url}</span>
                    <button
                      className="btn-secondary"
                      style={{ padding: '2px 8px', fontSize: '11px' }}
                      onClick={() => useRequestId(req.id)}
                    >
                      Use
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Network placeholder when no session */}
          {rightPanelTab === 'network' && !sessionId && (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
              <div style={{ color: 'var(--text-muted)', fontSize: '13px', textAlign: 'center' }}>
                Start a browser session to view network requests
              </div>
            </div>
          )}

          {/* Secrets panel */}
          {rightPanelTab === 'secrets' && conversation?.packId && (
            <div style={{ margin: '12px', flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <SecretsPanel
                packId={conversation.packId}
                token={token}
              />
            </div>
          )}

          {/* Secrets placeholder when no pack linked */}
          {rightPanelTab === 'secrets' && !conversation?.packId && (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
              <div style={{ color: 'var(--text-muted)', fontSize: '13px', textAlign: 'center' }}>
                No pack linked to this conversation.
                <div style={{ marginTop: '8px', fontSize: '11px' }}>
                  Create or link a pack to manage secrets.
                </div>
              </div>
            </div>
          )}

          {/* Versions panel */}
          {rightPanelTab === 'versions' && conversation?.packId && (
            <div style={{ margin: '12px', flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <VersionPanel
                packId={conversation.packId}
                token={token}
              />
            </div>
          )}

          {/* Versions placeholder when no pack linked */}
          {rightPanelTab === 'versions' && !conversation?.packId && (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
              <div style={{ color: 'var(--text-muted)', fontSize: '13px', textAlign: 'center' }}>
                No pack linked to this conversation.
                <div style={{ marginTop: '8px', fontSize: '11px' }}>
                  Create or link a pack to manage versions.
                </div>
              </div>
            </div>
          )}

          {/* Run tab */}
          {rightPanelTab === 'run' && (
            <div style={{ margin: '12px', flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
              <div style={{ fontWeight: 600, fontSize: '14px', marginBottom: '12px' }}>Run Pack</div>
              {!conversation?.packId ? (
                <div style={{ color: 'var(--text-muted)', fontSize: '13px', textAlign: 'center', marginTop: '24px' }}>
                  No pack linked to this conversation.
                </div>
              ) : !flowInputSchema || Object.keys(flowInputSchema).length === 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                  <div style={{ color: 'var(--text-muted)', fontSize: '13px' }}>
                    No inputs defined — click Run to execute with defaults.
                  </div>
                  <button
                    className="btn-primary"
                    onClick={() => handleRunPack({})}
                    style={{ padding: '8px 16px', fontSize: '13px' }}
                  >
                    Run
                  </button>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  {Object.entries(flowInputSchema).map(([key, schema]) => (
                    <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      <label style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-primary)' }}>
                        {key}{schema.required ? ' *' : ''}
                      </label>
                      {schema.type === 'boolean' ? (
                        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}>
                          <input
                            type="checkbox"
                            checked={!!runInputValues[key]}
                            onChange={(e) => setRunInputValues(prev => ({ ...prev, [key]: e.target.checked }))}
                          />
                          {runInputValues[key] ? 'true' : 'false'}
                        </label>
                      ) : (
                        <input
                          type={schema.type === 'number' ? 'number' : 'text'}
                          value={runInputValues[key] !== undefined ? String(runInputValues[key]) : ''}
                          placeholder={schema.default !== undefined ? String(schema.default) : ''}
                          onChange={(e) => setRunInputValues(prev => ({
                            ...prev,
                            [key]: schema.type === 'number' ? (e.target.value === '' ? '' as unknown as number : Number(e.target.value)) : e.target.value,
                          }))}
                          style={{
                            padding: '6px 10px',
                            fontSize: '13px',
                            borderRadius: '6px',
                            border: '1px solid var(--border-subtle)',
                            backgroundColor: 'var(--bg-primary)',
                            color: 'var(--text-primary)',
                            outline: 'none',
                          }}
                        />
                      )}
                      {schema.description && (
                        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                          {schema.description}
                        </div>
                      )}
                    </div>
                  ))}
                  <button
                    className="btn-primary"
                    onClick={() => {
                      const inputs: Record<string, unknown> = {};
                      for (const [key, schema] of Object.entries(flowInputSchema)) {
                        const val = runInputValues[key];
                        if (val !== undefined && val !== '') {
                          inputs[key] = schema.type === 'number' ? Number(val) : val;
                        }
                      }
                      handleRunPack(inputs);
                    }}
                    disabled={Object.entries(flowInputSchema).some(([key, schema]) =>
                      schema.required && (runInputValues[key] === undefined || runInputValues[key] === '')
                    )}
                    style={{ padding: '8px 16px', fontSize: '13px', marginTop: '4px' }}
                  >
                    Run
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Research panel */}
          {rightPanelTab === 'research' && (
            <div style={{ margin: '12px', flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ fontWeight: 600, fontSize: '14px' }}>Research</div>
                <button
                  className="btn-primary"
                  onClick={handleRunResearch}
                  disabled={researchLoading}
                  style={{ padding: '4px 12px', fontSize: '12px' }}
                >
                  {researchLoading ? 'Searching...' : 'Search Techniques'}
                </button>
              </div>
              {researchResult && (
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  <span>{researchResult.totalTechniquesFound} techniques found</span>
                  <span>{researchResult.techniqueGroups.length} categories</span>
                </div>
              )}
              {researchResult && researchResult.techniqueGroups.length > 0 && (
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                  {researchResult.techniqueGroups.map(g => (
                    <span key={g.category} style={{
                      padding: '1px 6px',
                      borderRadius: '3px',
                      backgroundColor: 'rgba(59, 130, 246, 0.1)',
                      color: 'var(--accent-blue)',
                    }}>
                      {g.category} ({g.techniques.length})
                    </span>
                  ))}
                </div>
              )}
              <textarea
                value={researchPrompt}
                onChange={(e) => setResearchPrompt(e.target.value)}
                placeholder="Click 'Search Techniques' to find relevant techniques from the knowledge base. The compiled prompt will appear here and you can edit it before injecting into the conversation."
                style={{
                  flex: 1,
                  padding: '10px',
                  fontSize: '12px',
                  fontFamily: 'monospace',
                  lineHeight: '1.5',
                  borderRadius: '6px',
                  border: '1px solid var(--border-subtle)',
                  backgroundColor: 'var(--bg-primary)',
                  color: 'var(--text-primary)',
                  resize: 'none',
                  outline: 'none',
                }}
              />
              <button
                className="btn-secondary"
                onClick={() => {
                  if (researchPrompt.trim()) {
                    setInputValue(prev => prev ? `${prev}\n\n---\n\n${researchPrompt}` : researchPrompt);
                  }
                }}
                disabled={!researchPrompt.trim()}
                style={{ padding: '6px 12px', fontSize: '12px' }}
              >
                Inject into Message
              </button>
            </div>
          )}

          {/* Tab buttons */}
          <div style={{
            display: 'flex',
            gap: '4px',
            padding: '8px 12px',
            borderTop: '1px solid var(--border-subtle)',
            alignItems: 'center',
          }}>
            {([
              { key: 'network' as const, label: 'Network', show: true },
              { key: 'research' as const, label: 'Research', show: true },
              { key: 'secrets' as const, label: 'Secrets', show: !!conversation?.packId },
              { key: 'versions' as const, label: 'Versions', show: !!conversation?.packId },
              { key: 'run' as const, label: 'Run', show: !!conversation?.packId && conversation.status === 'ready' },
            ]).filter(t => t.show).map(tab => (
              <button
                key={tab.key}
                className="btn-secondary"
                style={{
                  flex: 1,
                  padding: '8px',
                  fontSize: '12px',
                  backgroundColor: rightPanelTab === tab.key ? 'var(--bg-card-active)' : undefined,
                }}
                onClick={() => {
                  if (rightPanelTab === tab.key) {
                    setRightPanelOpen(false);
                    setPanelAutoCollapsed(false);
                  } else {
                    setRightPanelTab(tab.key);
                  }
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
        </>
        )}
      </div>

      {/* Secrets Request Modal (AI-triggered) */}
      {secretsRequest && (conversation?.packId || secretsRequest.packId) && (
        <SecretsRequestModal
          secrets={secretsRequest.secrets}
          message={secretsRequest.message}
          packId={(conversation?.packId || secretsRequest.packId)!}
          conversationId={conversation?.id || ''}
          token={token}
          onComplete={() => setSecretsRequest(null)}
          onCancel={() => setSecretsRequest(null)}
        />
      )}

      {/* MCP Usage Modal */}
      {showMcpUsage && conversation?.packId && (
        <McpUsageModal
          packId={conversation.packId}
          onClose={() => setShowMcpUsage(false)}
          token={token}
        />
      )}
    </div>
  );
}
