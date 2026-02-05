import React, { useState, useEffect, useRef } from 'react';

interface Pack {
  id: string;
  name: string;
  version: string;
  description: string;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface TeachModeProps {
  token: string;
  packs: Pack[];
  onClose?: () => void;
  /** When set, Teach Mode is embedded in the pack editor: use this pack, hide pack selector, call onFlowUpdated when agent applies patches. */
  packId?: string;
  onFlowUpdated?: (flow: unknown) => void;
}

export default function TeachMode({ token, packs, onClose, packId: fixedPackId, onFlowUpdated }: TeachModeProps) {
  const [selectedPackId, setSelectedPackId] = useState<string>(fixedPackId ?? '');
  const effectivePackId = fixedPackId ?? selectedPackId;
  const embedInEditor = fixedPackId != null;

  useEffect(() => {
    if (fixedPackId != null) setSelectedPackId(fixedPackId);
  }, [fixedPackId]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // AbortController for stopping AI requests
  const abortControllerRef = useRef<AbortController | null>(null);

  // AI chat – always uses agent (MCPs always on)
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  type ToolTraceEntry = { tool: string; args: unknown; result: unknown; success: boolean };
  const [toolTrace, setToolTrace] = useState<ToolTraceEntry[]>([]);
  const [toolHistoryExpanded, setToolHistoryExpanded] = useState<Set<number>>(new Set());
  // Track currently executing tool for real-time visibility
  const [activeToolExecution, setActiveToolExecution] = useState<{ tool: string; args: unknown; startedAt: number } | null>(null);
  const [currentFlow, setCurrentFlow] = useState<unknown>(null);
  // Streaming thinking and content
  const [streamingThinking, setStreamingThinking] = useState<string>('');
  const [streamingContent, setStreamingContent] = useState<string>('');
  const [isThinking, setIsThinking] = useState(false);
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const [lastValidation, setLastValidation] = useState<{ ok: boolean; errors: string[]; warnings: string[] } | null>(null);
  const [isSummarizing, setIsSummarizing] = useState(false);
  const chatEndRef = React.useRef<HTMLDivElement | null>(null);

  // Network: request history so user can select one and provide id to AI
  interface NetworkEntryRow {
    id: string;
    ts: number;
    method: string;
    url: string;
    status?: number;
    isLikelyApi?: boolean;
  }
  const [networkRequests, setNetworkRequests] = useState<NetworkEntryRow[]>([]);
  const [networkLoading, setNetworkLoading] = useState(false);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

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

  const handleStartSession = async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await apiCall('/api/teach/browser/start', {
        method: 'POST',
        body: JSON.stringify({ headful: true }),
      });
      setSessionId(result.sessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleGoto = async () => {
    if (!sessionId) return;
    const url = prompt('Enter URL:');
    if (!url) return;

    try {
      setLoading(true);
      setError(null);
      await apiCall('/api/teach/browser/goto', {
        method: 'POST',
        body: JSON.stringify({ sessionId, url }),
      });
      await handleScreenshot();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleScreenshot = async () => {
    if (!sessionId) return;

    try {
      setLoading(true);
      setError(null);
      const result = await apiCall('/api/teach/browser/screenshot', {
        method: 'POST',
        body: JSON.stringify({ sessionId }),
      });
      const mime = result.mimeType || 'image/png';
      setScreenshot(`data:${mime};base64,${result.imageBase64}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleRunPack = async () => {
    if (!effectivePackId) return;

    try {
      setLoading(true);
      setError(null);
      await apiCall('/api/runs', {
        method: 'POST',
        body: JSON.stringify({ packId: effectivePackId, inputs: {} }),
      });
      alert('Run started! Check the Runs tab.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleSendChat = async () => {
    const text = chatInput.trim();
    if (!text || chatLoading) return;

    const userMessage: ChatMessage = { role: 'user', content: text };
    setChatMessages((prev) => [...prev, userMessage]);
    setChatInput('');
    setChatLoading(true);
    setError(null);
    // Clear tool trace and active tool for new request
    setToolTrace([]);
    setActiveToolExecution(null);
    // Clear streaming state
    setStreamingThinking('');
    setStreamingContent('');
    setIsThinking(false);

    const useStream = !!(effectivePackId && onFlowUpdated);

    // Create new AbortController for this request
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      const messagesForApi = [...chatMessages, userMessage].map((m) => ({
        role: m.role,
        content: m.content,
      }));

      if (useStream) {
        const response = await fetch('/api/teach/agent', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-showrun-token': token,
          },
          body: JSON.stringify({
            messages: messagesForApi,
            packId: effectivePackId || null,
            browserSessionId: sessionId || null,
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
          toolTrace?: unknown[];
          updatedFlow?: unknown;
          validation?: { ok: boolean; errors: string[]; warnings: string[] };
          browser?: { screenshotBase64?: string; mimeType?: string };
          browserSessionId?: string;
          error?: string;
        } = {};
        const processLine = (line: string) => {
          const trimmed = line.trim();
          if (!trimmed) return;
          try {
            const obj = JSON.parse(trimmed) as {
              type: string;
              flow?: unknown;
              validation?: unknown;
              error?: string;
              assistantMessage?: { content?: string };
              toolTrace?: unknown[];
              updatedFlow?: unknown;
              browser?: { screenshotBase64?: string; mimeType?: string };
              browserSessionId?: string;
              // New fields for real-time tool events
              tool?: string;
              args?: unknown;
              result?: unknown;
              success?: boolean;
              // Streaming thinking/content
              text?: string;
            };
            // Handle thinking stream events
            if (obj.type === 'thinking_start') {
              setIsThinking(true);
              setStreamingThinking('');
            } else if (obj.type === 'thinking_delta' && obj.text) {
              setStreamingThinking(prev => prev + obj.text);
            } else if (obj.type === 'thinking_stop') {
              setIsThinking(false);
            } else if (obj.type === 'content_start') {
              setStreamingContent('');
            } else if (obj.type === 'content_delta' && obj.text) {
              setStreamingContent(prev => prev + obj.text);
            } else if (obj.type === 'content_stop') {
              // Content finished streaming
            } else if (obj.type === 'tool_start') {
              // A tool is about to execute - show it to the user
              setActiveToolExecution({ tool: obj.tool!, args: obj.args, startedAt: Date.now() });
            } else if (obj.type === 'tool_result') {
              // Tool finished - clear active state and add to trace
              setActiveToolExecution(null);
              setToolTrace(prev => [...prev, {
                tool: obj.tool!,
                args: obj.args as Record<string, unknown>,
                result: obj.result,
                success: obj.success ?? true
              }]);
            } else if (obj.type === 'flow_updated') {
              if (obj.flow !== undefined) {
                setCurrentFlow(obj.flow);
                onFlowUpdated?.(obj.flow);
              }
              if (obj.validation !== undefined) setLastValidation(obj.validation as { ok: boolean; errors: string[]; warnings: string[] });
            } else if (obj.type === 'summarizing') {
              setIsSummarizing(true);
            } else if (obj.type === 'summarized') {
              setIsSummarizing(false);
            } else if (obj.type === 'done') {
              // Clear active tool on completion (safety)
              setActiveToolExecution(null);
              result = obj;
            }
          } catch {
            // ignore parse errors for partial lines
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
        setChatMessages((prev) => [...prev, { role: 'assistant', content: result.assistantMessage?.content ?? result.error ?? '' }]);
        if (result.toolTrace?.length) setToolTrace(result.toolTrace);
        if (result.updatedFlow !== undefined) {
          setCurrentFlow(result.updatedFlow);
          onFlowUpdated?.(result.updatedFlow);
        }
        if (result.validation) setLastValidation(result.validation);
        if (result.browser?.screenshotBase64) {
          const mime = result.browser.mimeType || 'image/png';
          setScreenshot(`data:${mime};base64,${result.browser.screenshotBase64}`);
        }
        if (result.browserSessionId && !sessionId) setSessionId(result.browserSessionId);
        if (result.error) setError(result.error);
      } else {
        const result = await apiCall('/api/teach/agent', {
          method: 'POST',
          body: JSON.stringify({
            messages: messagesForApi,
            packId: effectivePackId || null,
            browserSessionId: sessionId || null,
          }),
        });
        setChatMessages((prev) => [...prev, { role: 'assistant', content: result.assistantMessage?.content ?? '' }]);
        if (result.toolTrace?.length) setToolTrace(result.toolTrace);
        if (result.updatedFlow !== undefined) {
          setCurrentFlow(result.updatedFlow);
          onFlowUpdated?.(result.updatedFlow);
        }
        if (result.validation) setLastValidation(result.validation);
        if (result.browser?.screenshotBase64) {
          const mime = result.browser.mimeType || 'image/png';
          setScreenshot(`data:${mime};base64,${result.browser.screenshotBase64}`);
        }
        if (result.browserSessionId && !sessionId) setSessionId(result.browserSessionId);
      }
    } catch (err) {
      // Handle abort gracefully - don't show as error
      if (err instanceof Error && err.name === 'AbortError') {
        setChatMessages((prev) => [...prev, { role: 'assistant', content: '(Stopped by user)' }]);
      } else {
        setError(err instanceof Error ? err.message : String(err));
        setChatMessages((prev) => [...prev, { role: 'assistant', content: `Error: ${err instanceof Error ? err.message : String(err)}` }]);
      }
      setActiveToolExecution(null); // Clear on error
    } finally {
      setChatLoading(false);
      setActiveToolExecution(null); // Safety clear
      abortControllerRef.current = null; // Clear abort controller
      // Clear streaming state
      setStreamingThinking('');
      setStreamingContent('');
      setIsThinking(false);
      setIsSummarizing(false);
    }
  };

  const handleStopChat = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  };

  useEffect(() => {
    if (sessionId) {
      handleScreenshot();
    }
  }, [sessionId]);

  const loadNetworkList = async () => {
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

  useEffect(() => {
    if (sessionId) loadNetworkList();
    else setNetworkRequests([]);
  }, [sessionId]);

  const useRequestId = (requestId: string) => {
    setChatInput(`Use request ${requestId}`);
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
      return s.length > maxLen ? s.slice(0, maxLen) + '\n…' : s;
    } catch {
      return String(obj);
    }
  };

  return (
    <div style={{ padding: embedInEditor ? '0' : '20px', display: 'flex', flexDirection: 'column', height: embedInEditor ? 'auto' : '100%', minHeight: 0 }}>
      {/* CSS keyframes for spinner animation */}
      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
      {!embedInEditor && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', flexShrink: 0 }}>
          <h2>Teach Mode</h2>
          {onClose && <button onClick={onClose}>Close</button>}
        </div>
      )}

      {error && (
        <div style={{ padding: '10px', backgroundColor: '#fee', color: '#c00', marginBottom: '20px', borderRadius: '4px' }}>
          Error: {error}
        </div>
      )}

      {!embedInEditor && (
        <div style={{ marginBottom: '20px' }}>
          <label>
            Select Pack:
            <select
              value={selectedPackId}
              onChange={(e) => setSelectedPackId(e.target.value)}
              style={{ marginLeft: '10px', padding: '5px' }}
            >
              <option value="">-- Select --</option>
              {packs.map((pack) => (
                <option key={pack.id} value={pack.id}>
                  {pack.name} ({pack.id})
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      <div style={{ marginBottom: '20px', display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
        {!sessionId ? (
          <button onClick={handleStartSession} disabled={loading}>
            Start Browser Session
          </button>
        ) : (
          <>
            <button onClick={handleGoto} disabled={loading}>
              Goto URL
            </button>
            <button onClick={handleScreenshot} disabled={loading}>
              Screenshot
            </button>
            <button onClick={handleRunPack} disabled={loading || !effectivePackId}>
              Run Pack
            </button>
          </>
        )}
      </div>

      {screenshot && (
        <div style={{ marginBottom: '20px' }}>
          <img src={screenshot} alt="Screenshot" style={{ maxWidth: '100%', border: '1px solid #ccc' }} />
        </div>
      )}

      {/* Network: request history – select one and provide id to AI */}
      {sessionId && (
        <div style={{ marginBottom: '20px', border: '1px solid #ccc', borderRadius: '8px', overflow: 'hidden' }}>
          <div style={{ padding: '10px 12px', backgroundColor: '#f8f9fa', fontWeight: 600, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>Network</span>
            <button type="button" onClick={loadNetworkList} disabled={networkLoading} style={{ fontSize: '12px', padding: '4px 8px' }}>
              {networkLoading ? '…' : 'Refresh'}
            </button>
          </div>
          <div style={{ maxHeight: '180px', overflow: 'auto' }}>
            {networkRequests.length === 0 && !networkLoading && (
              <div style={{ padding: '12px', color: '#666', fontSize: '14px' }}>No requests yet. Navigate or interact in the browser, then Refresh.</div>
            )}
            {networkRequests.map((req) => (
              <div
                key={req.id}
                style={{
                  padding: '8px 12px',
                  borderBottom: '1px solid #eee',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  flexWrap: 'wrap',
                }}
              >
                <span style={{ fontFamily: 'monospace', fontSize: '12px', color: '#666' }}>{req.method}</span>
                {req.status != null && (
                  <span style={{ fontFamily: 'monospace', fontSize: '12px', color: req.status >= 400 ? '#c00' : '#0a0' }}>
                    {req.status}
                  </span>
                )}
                <span style={{ flex: 1, minWidth: 0, fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={req.url}>
                  {req.url}
                </span>
                <button
                  type="button"
                  onClick={() => useRequestId(req.id)}
                  style={{ fontSize: '12px', padding: '4px 8px', flexShrink: 0 }}
                >
                  Use this request
                </button>
              </div>
            ))}
          </div>
          <div style={{ padding: '8px 12px', backgroundColor: '#f0f4f8', fontSize: '12px', color: '#555' }}>
            Click &quot;Use this request&quot; to send its ID to the AI; it will call network_get with that id.
          </div>
        </div>
      )}

      {/* Tool call history – inputs and responses from the last agent turn */}
      {(toolTrace.length > 0 || activeToolExecution) && (
        <div style={{ marginBottom: '20px', border: '1px solid #ccc', borderRadius: '8px', overflow: 'hidden' }}>
          <div style={{ padding: '10px 12px', backgroundColor: '#f8f9fa', fontWeight: 600, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>Tool call history</span>
            {activeToolExecution && (
              <span style={{ fontSize: '12px', color: '#666', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span style={{
                  display: 'inline-block',
                  width: '10px',
                  height: '10px',
                  border: '2px solid #ccc',
                  borderTopColor: '#666',
                  borderRadius: '50%',
                  animation: 'spin 1s linear infinite'
                }} />
                Running...
              </span>
            )}
          </div>
          <div style={{ maxHeight: '360px', overflow: 'auto' }}>
            {toolTrace.map((t, i) => (
              <div
                key={i}
                style={{
                  borderBottom: i < toolTrace.length - 1 ? '1px solid #eee' : 'none',
                  padding: '10px 12px',
                }}
              >
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
                    fontSize: '14px',
                  }}
                >
                  <span style={{ color: t.success ? '#0a0' : '#c00', flexShrink: 0 }}>{t.success ? '✓' : '✗'}</span>
                  <span style={{ fontFamily: 'monospace', fontWeight: 500 }}>{t.tool}</span>
                  <span style={{ color: '#666', fontSize: '12px' }}>{toolHistoryExpanded.has(i) ? '▼' : '▶'}</span>
                </button>
                {toolHistoryExpanded.has(i) && (
                  <div style={{ marginTop: '10px', paddingLeft: '8px', borderLeft: '3px solid #ddd' }}>
                    <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '4px', color: '#555' }}>Inputs</div>
                    <pre
                      style={{
                        margin: '0 0 12px 0',
                        padding: '10px',
                        backgroundColor: '#f5f5f5',
                        borderRadius: '4px',
                        fontSize: '12px',
                        overflow: 'auto',
                        maxHeight: '160px',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                      }}
                    >
                      {formatToolPayload(t.args)}
                    </pre>
                    <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '4px', color: '#555' }}>Response</div>
                    <pre
                      style={{
                        margin: 0,
                        padding: '10px',
                        backgroundColor: '#f0f4f8',
                        borderRadius: '4px',
                        fontSize: '12px',
                        overflow: 'auto',
                        maxHeight: '200px',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                      }}
                    >
                      {formatToolPayload(t.result)}
                    </pre>
                  </div>
                )}
              </div>
            ))}
            {/* Show currently executing tool at the end of the list */}
            {activeToolExecution && (
              <div
                style={{
                  borderTop: toolTrace.length > 0 ? '1px solid #eee' : 'none',
                  padding: '10px 12px',
                  backgroundColor: '#fffbeb',
                }}
              >
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  fontSize: '14px',
                }}>
                  <span style={{
                    display: 'inline-block',
                    width: '14px',
                    height: '14px',
                    border: '2px solid #d4a574',
                    borderTopColor: '#b8860b',
                    borderRadius: '50%',
                    animation: 'spin 1s linear infinite',
                    flexShrink: 0
                  }} />
                  <span style={{ fontFamily: 'monospace', fontWeight: 500 }}>{activeToolExecution.tool}</span>
                  <span style={{ color: '#b8860b', fontSize: '12px' }}>executing...</span>
                </div>
                {/* Show arguments while executing */}
                <div style={{ marginTop: '10px', paddingLeft: '8px', borderLeft: '3px solid #f0d080' }}>
                  <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '4px', color: '#555' }}>Inputs</div>
                  <pre
                    style={{
                      margin: 0,
                      padding: '10px',
                      backgroundColor: '#fef9e7',
                      borderRadius: '4px',
                      fontSize: '12px',
                      overflow: 'auto',
                      maxHeight: '120px',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    }}
                  >
                    {formatToolPayload(activeToolExecution.args)}
                  </pre>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {loading && <div style={{ marginTop: '20px' }}>Loading...</div>}

      {/* AI Chat box for flow writing */}
      <div
        style={{
          marginTop: '24px',
          border: '1px solid #ccc',
          borderRadius: '8px',
          display: 'flex',
          flexDirection: 'column',
          minHeight: '280px',
          maxHeight: '400px',
          flex: '1 1 auto',
          overflow: 'hidden',
        }}
      >
        <div style={{ padding: '10px 12px', borderBottom: '1px solid #eee', backgroundColor: '#f8f9fa', fontWeight: 600 }}>
          AI – Write flow (Editor + Browser MCPs always on)
        </div>
        <div
          style={{
            flex: 1,
            overflow: 'auto',
            padding: '12px',
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
          }}
        >
          {chatMessages.length === 0 && (
            <div style={{ color: '#666', fontSize: '14px' }}>
              Describe what you want (e.g. &quot;Create a flow that goes to example.com and extracts the title&quot;). The agent will use Editor and Browser MCPs to read packs, apply steps, and control the browser.
            </div>
          )}
          {chatMessages.map((msg, i) => (
            <div
              key={i}
              style={{
                alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
                maxWidth: '85%',
                padding: '10px 14px',
                borderRadius: '8px',
                backgroundColor: msg.role === 'user' ? '#e3f2fd' : '#f5f5f5',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontSize: '14px',
              }}
            >
              {msg.content}
            </div>
          ))}
          {chatLoading && (
            <div style={{ alignSelf: 'flex-start', maxWidth: '85%', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {/* Streaming thinking output */}
              {(streamingThinking || isThinking) && (
                <div style={{
                  padding: '10px 14px',
                  backgroundColor: '#f0f0ff',
                  borderRadius: '8px',
                  border: '1px solid #d0d0ff',
                }}>
                  <div
                    onClick={() => setThinkingExpanded(!thinkingExpanded)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      cursor: 'pointer',
                      marginBottom: streamingThinking && thinkingExpanded ? '8px' : 0,
                    }}
                  >
                    {isThinking && (
                      <span style={{
                        display: 'inline-block',
                        width: '12px',
                        height: '12px',
                        border: '2px solid #a0a0ff',
                        borderTopColor: '#6060ff',
                        borderRadius: '50%',
                        animation: 'spin 1s linear infinite'
                      }} />
                    )}
                    <span style={{ color: '#6060ff', fontWeight: 500, fontSize: '13px' }}>
                      {isThinking ? 'Thinking...' : 'Thought'}
                    </span>
                    <span style={{ color: '#888', fontSize: '12px' }}>{thinkingExpanded ? '▼' : '▶'}</span>
                  </div>
                  {streamingThinking && thinkingExpanded && (
                    <pre style={{
                      margin: 0,
                      fontSize: '12px',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      color: '#555',
                      maxHeight: '200px',
                      overflow: 'auto',
                    }}>
                      {streamingThinking}
                    </pre>
                  )}
                </div>
              )}
              {/* Streaming content output */}
              {streamingContent && (
                <div style={{
                  padding: '10px 14px',
                  backgroundColor: '#f5f5f5',
                  borderRadius: '8px',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontSize: '14px',
                }}>
                  {streamingContent}
                </div>
              )}
              {/* Tool execution indicator */}
              {activeToolExecution && (
                <div style={{ padding: '10px 14px', backgroundColor: '#fff8e8', borderRadius: '8px', color: '#666' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{
                      display: 'inline-block',
                      width: '14px',
                      height: '14px',
                      border: '2px solid #f0c060',
                      borderTopColor: '#d09020',
                      borderRadius: '50%',
                      animation: 'spin 1s linear infinite'
                    }} />
                    <span>Executing: <code style={{ backgroundColor: '#e8e8e8', padding: '2px 6px', borderRadius: '4px', fontFamily: 'monospace', fontSize: '13px' }}>{activeToolExecution.tool}</code></span>
                  </div>
                </div>
              )}
              {/* Summarization indicator */}
              {isSummarizing && (
                <div style={{ padding: '10px 14px', backgroundColor: '#fff3cd', borderRadius: '8px', color: '#856404', border: '1px solid #ffc107' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{
                      display: 'inline-block',
                      width: '14px',
                      height: '14px',
                      border: '2px solid #ffc107',
                      borderTopColor: '#856404',
                      borderRadius: '50%',
                      animation: 'spin 1s linear infinite'
                    }} />
                    <span>Summarizing conversation to reduce context size...</span>
                  </div>
                </div>
              )}
              {/* Generic loading indicator when nothing else is showing */}
              {!streamingThinking && !isThinking && !streamingContent && !activeToolExecution && !isSummarizing && (
                <div style={{ padding: '10px 14px', backgroundColor: '#f5f5f5', borderRadius: '8px', color: '#666' }}>
                  …
                </div>
              )}
            </div>
          )}
          <div ref={chatEndRef} />
        </div>
        {currentFlow != null && !embedInEditor && (
          <div style={{ padding: '10px 12px', borderTop: '1px solid #eee', backgroundColor: '#f8fff8', maxHeight: '140px', overflow: 'auto' }}>
            <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '6px' }}>Updated flow</div>
            {lastValidation && (
              <div style={{ fontSize: '12px', marginBottom: '4px', color: lastValidation.ok ? '#0a0' : '#c00' }}>
                {lastValidation.ok ? '✓ Valid' : `✗ ${lastValidation.errors.join('; ')}`}
              </div>
            )}
            <pre style={{ margin: 0, fontSize: '11px', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {JSON.stringify(currentFlow, null, 2).slice(0, 800)}
              {(JSON.stringify(currentFlow).length > 800) ? '…' : ''}
            </pre>
          </div>
        )}
        {currentFlow != null && embedInEditor && lastValidation && (
          <div style={{ padding: '8px 12px', borderTop: '1px solid #eee', backgroundColor: lastValidation.ok ? '#f0fff0' : '#fff0f0', fontSize: '12px', color: lastValidation.ok ? '#0a0' : '#c00' }}>
            {lastValidation.ok ? '✓ Flow updated in editor above' : `✗ ${lastValidation.errors.join('; ')}`}
          </div>
        )}
        <div style={{ padding: '10px', borderTop: '1px solid #eee', display: 'flex', gap: '8px' }}>
          <input
            type="text"
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSendChat();
              }
            }}
            placeholder="Describe a step or ask how to write the flow..."
            style={{
              flex: 1,
              padding: '10px 12px',
              border: '1px solid #ccc',
              borderRadius: '6px',
              fontSize: '14px',
            }}
            disabled={chatLoading}
          />
          {chatLoading ? (
            <button
              onClick={handleStopChat}
              style={{
                padding: '10px 16px',
                borderRadius: '6px',
                fontWeight: 500,
                backgroundColor: '#dc3545',
                color: 'white',
                border: 'none',
                cursor: 'pointer',
              }}
            >
              Stop
            </button>
          ) : (
            <button
              onClick={handleSendChat}
              disabled={!chatInput.trim()}
              style={{ padding: '10px 16px', borderRadius: '6px', fontWeight: 500 }}
            >
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
