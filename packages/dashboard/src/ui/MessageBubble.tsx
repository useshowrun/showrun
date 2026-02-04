import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';

export interface ToolCall {
  id?: string;
  name?: string;
  tool?: string; // Alternative to name (from tool trace)
  arguments?: string;
  args?: Record<string, unknown>; // Alternative to arguments (from tool trace)
  result?: unknown;
  success?: boolean;
}

interface MessageBubbleProps {
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolCalls?: ToolCall[];
  thinking?: string;
  isStreaming?: boolean;
}

export default function MessageBubble({
  role,
  content,
  toolCalls,
  thinking,
  isStreaming,
}: MessageBubbleProps) {
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const [toolsExpanded, setToolsExpanded] = useState(true); // Default expanded
  const [expandedTools, setExpandedTools] = useState<Set<number>>(new Set());

  const formatPayload = (data: unknown): string => {
    try {
      if (typeof data === 'string') {
        // Try to parse if it's a JSON string
        try {
          const parsed = JSON.parse(data);
          return JSON.stringify(parsed, null, 2);
        } catch {
          return data;
        }
      }
      return JSON.stringify(data, null, 2);
    } catch {
      return String(data);
    }
  };

  const toggleToolExpanded = (index: number) => {
    setExpandedTools((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  const getToolName = (tc: ToolCall): string => {
    return tc.name || tc.tool || 'unknown';
  };

  const getToolArgs = (tc: ToolCall): string => {
    if (tc.arguments) {
      return formatPayload(tc.arguments);
    }
    if (tc.args) {
      return formatPayload(tc.args);
    }
    return '{}';
  };

  return (
    <div className={`message-bubble ${role}`}>
      {/* Thinking section for assistant */}
      {role === 'assistant' && thinking && (
        <div className="thinking-section">
          <div
            className="thinking-header"
            onClick={() => setThinkingExpanded(!thinkingExpanded)}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className={`collapsible-arrow ${thinkingExpanded ? 'expanded' : ''}`}
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
            <span>Thinking</span>
          </div>
          {thinkingExpanded && (
            <div className="thinking-content">{thinking}</div>
          )}
        </div>
      )}

      {/* Tool calls section BEFORE content (since tools execute first) */}
      {role === 'assistant' && toolCalls && toolCalls.length > 0 && (
        <div className="tool-call-section" style={{ marginBottom: content ? '12px' : 0 }}>
          <div
            className="tool-call-header"
            onClick={() => setToolsExpanded(!toolsExpanded)}
            style={{ cursor: 'pointer' }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className={`collapsible-arrow ${toolsExpanded ? 'expanded' : ''}`}
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
            <span>Tools ({toolCalls.length})</span>
          </div>
          {toolsExpanded && (
            <div style={{ marginTop: '10px' }}>
              {toolCalls.map((tc, idx) => {
                const isExpanded = expandedTools.has(idx);
                const success = tc.success !== false;
                const toolName = getToolName(tc);

                return (
                  <div
                    key={tc.id || idx}
                    style={{
                      marginTop: idx > 0 ? '8px' : 0,
                      background: 'var(--bg-input)',
                      borderRadius: '6px',
                      border: `1px solid ${success ? 'var(--border-subtle)' : 'rgba(239, 68, 68, 0.3)'}`,
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => toggleToolExpanded(idx)}
                      style={{
                        width: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        padding: '8px 10px',
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        textAlign: 'left',
                        color: 'var(--text-primary)',
                      }}
                    >
                      <span style={{
                        color: success ? 'var(--accent-green, #22c55e)' : 'var(--accent-red, #ef4444)',
                        fontWeight: 'bold',
                      }}>
                        {success ? '✓' : '✗'}
                      </span>
                      <span className="tool-call-name" style={{ flex: 1 }}>{toolName}</span>
                      <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                        {isExpanded ? '▼' : '▶'}
                      </span>
                    </button>

                    {isExpanded && (
                      <div style={{ padding: '0 10px 10px', borderTop: '1px solid var(--border-subtle)' }}>
                        <div style={{ fontSize: '11px', fontWeight: 600, marginTop: '8px', marginBottom: '4px', color: 'var(--text-muted)' }}>
                          Input
                        </div>
                        <pre style={{
                          margin: 0,
                          padding: '8px',
                          backgroundColor: 'var(--bg-main)',
                          borderRadius: '4px',
                          fontSize: '11px',
                          overflow: 'auto',
                          maxHeight: '100px',
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                          color: 'var(--text-secondary)',
                        }}>
                          {getToolArgs(tc)}
                        </pre>

                        {tc.result !== undefined && (
                          <>
                            <div style={{ fontSize: '11px', fontWeight: 600, marginTop: '8px', marginBottom: '4px', color: 'var(--text-muted)' }}>
                              Result
                            </div>
                            <pre style={{
                              margin: 0,
                              padding: '8px',
                              backgroundColor: 'var(--bg-main)',
                              borderRadius: '4px',
                              fontSize: '11px',
                              overflow: 'auto',
                              maxHeight: '150px',
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-word',
                              color: 'var(--text-secondary)',
                            }}>
                              {formatPayload(tc.result)}
                            </pre>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Main content */}
      {content && (
        <div className="markdown-content">
          {role === 'user' ? (
            // User messages: plain text, no markdown
            <div style={{ whiteSpace: 'pre-wrap' }}>{content}</div>
          ) : (
            // Assistant messages: render markdown
            <ReactMarkdown
              components={{
                // Custom code rendering
                code: ({ node, className, children, ...props }) => {
                  const isInline = !className;
                  return isInline ? (
                    <code {...props}>{children}</code>
                  ) : (
                    <pre>
                      <code className={className} {...props}>
                        {children}
                      </code>
                    </pre>
                  );
                },
              }}
            >
              {content}
            </ReactMarkdown>
          )}
        </div>
      )}

      {/* Streaming indicator */}
      {isStreaming && (
        <div style={{ marginTop: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span className="spinner" />
          <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            Generating...
          </span>
        </div>
      )}
    </div>
  );
}
