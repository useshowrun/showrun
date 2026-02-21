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
  const [rightPanelTab, setRightPanelTab] = useState<'network' | 'secrets' | 'versions'>('network');

  // Secrets request modal state (AI-triggered)
  const [secretsRequest, setSecretsRequest] = useState<{
    secrets: Array<{ name: string; description?: string; required?: boolean }>;
    message: string;
    packId?: string; // packId from streaming event, in case conversation.packId hasn't synced yet
  } | null>(null);

  // MCP Usage modal
  const [showMcpUsage, setShowMcpUsage] = useState(false);

  // Network requests
  const [networkRequests, setNetworkRequests] = useState<NetworkEntry[]>([]);
  const [networkLoading, setNetworkLoading] = useState(false);

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

      // Add assistant message with tool calls
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

      // Save assistant message to database
      try {
        await apiCall(`/api/conversations/${conversation.id}/messages`, {
          method: 'POST',
          body: JSON.stringify({
            role: 'assistant',
            content: assistantContent,
            toolCalls: finalToolTrace,
            thinkingContent: streamingThinking || null,
          }),
        });
      } catch (err) {
        console.error('Failed to save assistant message:', err);
      }

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

      // Build message with captured data
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

      // Persist the partial message to database
      if (conversation) {
        try {
          await apiCall(`/api/conversations/${conversation.id}/messages`, {
            method: 'POST',
            body: JSON.stringify({
              role: 'assistant',
              content: finalContent,
              toolCalls: capturedToolTrace.length > 0 ? capturedToolTrace : null,
              thinkingContent: capturedThinking || null,
            }),
          });
        } catch (saveErr) {
          console.error('Failed to save partial assistant message:', saveErr);
        }
      }

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

  const handleRunPack = async () => {
    if (!conversation?.packId) return;
    try {
      setError(null);
      await apiCall('/api/runs', {
        method: 'POST',
        body: JSON.stringify({
          packId: conversation.packId,
          inputs: {},
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
          {conversation.packId && conversation.status === 'ready' && (
            <button
              className="btn-primary"
              onClick={handleRunPack}
              title="Run this pack"
              style={{ padding: '4px 10px', fontSize: '12px' }}
            >
              Run
            </button>
          )}
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

        {/* Right side panel (network / secrets) */}
        <div style={{
          width: '400px',
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

          {/* Tab buttons */}
          <div style={{
            display: 'flex',
            gap: '8px',
            padding: '12px',
            borderTop: '1px solid var(--border-subtle)',
          }}>
            <button
              className="btn-secondary"
              style={{
                flex: 1,
                padding: '8px',
                fontSize: '12px',
                backgroundColor: rightPanelTab === 'network' ? 'var(--bg-card-active)' : undefined,
              }}
              onClick={() => setRightPanelTab('network')}
            >
              Network
            </button>
            {conversation?.packId && (
              <button
                className="btn-secondary"
                style={{
                  flex: 1,
                  padding: '8px',
                  fontSize: '12px',
                  backgroundColor: rightPanelTab === 'secrets' ? 'var(--bg-card-active)' : undefined,
                }}
                onClick={() => setRightPanelTab('secrets')}
              >
                Secrets
              </button>
            )}
            {conversation?.packId && (
              <button
                className="btn-secondary"
                style={{
                  flex: 1,
                  padding: '8px',
                  fontSize: '12px',
                  backgroundColor: rightPanelTab === 'versions' ? 'var(--bg-card-active)' : undefined,
                }}
                onClick={() => setRightPanelTab('versions')}
              >
                Versions
              </button>
            )}
          </div>
        </div>
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
