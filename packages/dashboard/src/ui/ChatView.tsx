import React, { useState, useEffect, useRef } from 'react';
import MessageBubble, { type ToolCall } from './MessageBubble.js';
import ChatInput from './ChatInput.js';

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
  onConversationUpdate?: (updates: Partial<Conversation>) => void;
  onNewMessage?: (message: Message) => void;
}

export default function ChatView({
  conversation,
  token,
  onConversationUpdate,
  onNewMessage,
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
  const [showBrowser, setShowBrowser] = useState(true);
  const [showNetwork, setShowNetwork] = useState(false);
  const [showToolHistory, setShowToolHistory] = useState(true);
  const [toolHistoryExpanded, setToolHistoryExpanded] = useState<Set<number>>(new Set());

  // Network requests
  const [networkRequests, setNetworkRequests] = useState<NetworkEntry[]>([]);
  const [networkLoading, setNetworkLoading] = useState(false);

  // Refs
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

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
        'x-mcpify-token': token,
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

  const handleSend = async () => {
    const text = inputValue.trim();
    if (!text || isLoading || !conversation) return;

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
          'x-mcpify-token': token,
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
          } else if (obj.type === 'thinking_delta' && obj.text) {
            setStreamingThinking((prev) => prev + obj.text);
          } else if (obj.type === 'thinking_stop') {
            setIsThinking(false);
          } else if (obj.type === 'content_start') {
            setStreamingContent('');
          } else if (obj.type === 'content_delta' && obj.text) {
            setStreamingContent((prev) => prev + obj.text);
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
            setToolTrace((prev) => [
              ...prev,
              {
                tool: obj.tool!,
                args: obj.args as Record<string, unknown>,
                result: obj.result,
                success: obj.success ?? true,
              },
            ]);
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
      if (err instanceof Error && err.name === 'AbortError') {
        const stoppedMessage: Message = {
          id: `temp-${Date.now()}`,
          role: 'assistant',
          content: '(Stopped by user)',
          createdAt: Date.now(),
        };
        setMessages((prev) => [...prev, stoppedMessage]);
      } else {
        setError(err instanceof Error ? err.message : String(err));
        const errorMessage: Message = {
          id: `temp-${Date.now()}`,
          role: 'assistant',
          content: `Error: ${err instanceof Error ? err.message : String(err)}`,
          createdAt: Date.now(),
        };
        setMessages((prev) => [...prev, errorMessage]);
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
    }
  };

  const handleStop = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  };

  const toggleToolHistoryEntry = (index: number) => {
    setToolHistoryExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const formatToolPayload = (obj: unknown, maxLen: number = 2000): string => {
    try {
      const s = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
      return s.length > maxLen ? s.slice(0, maxLen) + '\n...' : s;
    } catch {
      return String(obj);
    }
  };

  const useRequestId = (requestId: string) => {
    setInputValue(`Use request ${requestId}`);
  };

  if (!conversation) {
    return (
      <div className="welcome-screen">
        <div className="welcome-logo">FlowForge</div>
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
                  ...toolTrace,
                  ...(activeToolExecution ? [{
                    tool: activeToolExecution.tool,
                    args: activeToolExecution.args as Record<string, unknown>,
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
                    backgroundColor: 'rgba(245, 158, 11, 0.1)',
                    border: '1px solid rgba(245, 158, 11, 0.2)',
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

        {/* Right side panel (browser, network, tools) */}
        <div style={{
          width: '400px',
          borderLeft: '1px solid var(--border-subtle)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          backgroundColor: 'var(--bg-sidebar)',
        }}>
          {/* Browser panel */}
          {showBrowser && (
            <div className="browser-panel" style={{ margin: '12px', flex: screenshot ? 'none' : 1 }}>
              <div className="browser-panel-header">
                <span>Browser</span>
                {!sessionId ? (
                  <button
                    className="btn-secondary"
                    style={{ padding: '4px 12px', fontSize: '12px' }}
                    onClick={handleStartSession}
                    disabled={isLoading}
                  >
                    Start Session
                  </button>
                ) : (
                  <button
                    className="btn-secondary"
                    style={{ padding: '4px 12px', fontSize: '12px' }}
                    onClick={loadNetworkRequests}
                  >
                    Refresh
                  </button>
                )}
              </div>
              {screenshot ? (
                <img
                  src={screenshot}
                  alt="Browser screenshot"
                  className="browser-screenshot"
                  style={{ maxHeight: '300px', objectFit: 'contain' }}
                />
              ) : (
                <div style={{
                  padding: '40px 20px',
                  textAlign: 'center',
                  color: 'var(--text-muted)',
                  fontSize: '13px',
                }}>
                  {sessionId ? 'Waiting for screenshot...' : 'Click "Start Session" to begin'}
                </div>
              )}
            </div>
          )}

          {/* Network panel */}
          {showNetwork && sessionId && (
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

          {/* Tool history panel */}
          {showToolHistory && (
            <div className="tool-history" style={{ margin: '12px', flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <div className="tool-history-header">
                <span>Tool History</span>
                {activeToolExecution && (
                  <span style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--text-muted)' }}>
                    <span className="spinner" />
                    Running...
                  </span>
                )}
              </div>
              <div style={{ flex: 1, overflow: 'auto' }}>
                {toolTrace.length === 0 && !activeToolExecution && (
                  <div style={{ padding: '16px', color: 'var(--text-muted)', fontSize: '13px', textAlign: 'center' }}>
                    No tools executed yet
                  </div>
                )}
                {toolTrace.map((t, i) => (
                  <div key={i} className="tool-history-item">
                    <button
                      type="button"
                      onClick={() => toggleToolHistoryEntry(i)}
                      style={{
                        width: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '10px',
                        padding: '4px 0',
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        textAlign: 'left',
                        color: 'var(--text-primary)',
                      }}
                    >
                      <span className={t.success ? 'tool-history-success' : 'tool-history-error'}>
                        {t.success ? '✓' : '✗'}
                      </span>
                      <span className="tool-history-name">{t.tool}</span>
                      <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                        {toolHistoryExpanded.has(i) ? '▼' : '▶'}
                      </span>
                    </button>
                    {toolHistoryExpanded.has(i) && (
                      <div style={{ marginTop: '10px', paddingLeft: '8px', borderLeft: '2px solid var(--border-subtle)' }}>
                        <div style={{ fontSize: '11px', fontWeight: 600, marginBottom: '4px', color: 'var(--text-muted)' }}>
                          Input
                        </div>
                        <pre style={{
                          margin: '0 0 12px 0',
                          padding: '8px',
                          backgroundColor: 'var(--bg-input)',
                          borderRadius: '4px',
                          fontSize: '11px',
                          overflow: 'auto',
                          maxHeight: '100px',
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                          color: 'var(--text-secondary)',
                        }}>
                          {formatToolPayload(t.args)}
                        </pre>
                        <div style={{ fontSize: '11px', fontWeight: 600, marginBottom: '4px', color: 'var(--text-muted)' }}>
                          Result
                        </div>
                        <pre style={{
                          margin: 0,
                          padding: '8px',
                          backgroundColor: 'var(--bg-input)',
                          borderRadius: '4px',
                          fontSize: '11px',
                          overflow: 'auto',
                          maxHeight: '100px',
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                          color: 'var(--text-secondary)',
                        }}>
                          {formatToolPayload(t.result)}
                        </pre>
                      </div>
                    )}
                  </div>
                ))}

                {/* Active tool execution */}
                {activeToolExecution && (
                  <div className="tool-history-item" style={{ backgroundColor: 'rgba(245, 158, 11, 0.05)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <span className="spinner" />
                      <span className="tool-history-name">{activeToolExecution.tool}</span>
                      <span style={{ color: 'var(--accent-orange)', fontSize: '12px' }}>executing...</span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Panel toggles */}
          <div style={{
            display: 'flex',
            gap: '8px',
            padding: '12px',
            borderTop: '1px solid var(--border-subtle)',
          }}>
            <button
              className={`btn-secondary ${showBrowser ? '' : ''}`}
              style={{
                flex: 1,
                padding: '8px',
                fontSize: '12px',
                backgroundColor: showBrowser ? 'var(--bg-card-active)' : undefined,
              }}
              onClick={() => setShowBrowser(!showBrowser)}
            >
              Browser
            </button>
            <button
              className={`btn-secondary ${showNetwork ? '' : ''}`}
              style={{
                flex: 1,
                padding: '8px',
                fontSize: '12px',
                backgroundColor: showNetwork ? 'var(--bg-card-active)' : undefined,
              }}
              onClick={() => setShowNetwork(!showNetwork)}
              disabled={!sessionId}
            >
              Network
            </button>
            <button
              className={`btn-secondary ${showToolHistory ? '' : ''}`}
              style={{
                flex: 1,
                padding: '8px',
                fontSize: '12px',
                backgroundColor: showToolHistory ? 'var(--bg-card-active)' : undefined,
              }}
              onClick={() => setShowToolHistory(!showToolHistory)}
            >
              Tools
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
