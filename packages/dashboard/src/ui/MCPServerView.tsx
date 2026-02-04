import React, { useState, useEffect } from 'react';

interface Pack {
  id: string;
  name: string;
  version: string;
  description: string;
}

interface Conversation {
  id: string;
  title: string;
  description: string | null;
  status: 'active' | 'ready' | 'needs_input' | 'error';
  packId: string | null;
}

interface MCPServerViewProps {
  packs: Pack[];
  token: string;
  conversations?: Conversation[];
}

interface MCPStatus {
  running: boolean;
  url?: string;
  port?: number;
  packIds?: string[];
}

function MCPServerView({ packs, token, conversations = [] }: MCPServerViewProps) {
  const [status, setStatus] = useState<MCPStatus | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [port, setPort] = useState<number>(3340);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Ready conversations that have packIds
  const readyFlows = conversations.filter((c) => c.status === 'ready' && c.packId);

  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/mcp/status');
      if (res.ok) {
        const data = (await res.json()) as MCPStatus;
        setStatus(data);
      }
    } catch (e) {
      console.error('Failed to fetch MCP status', e);
    }
  };

  useEffect(() => {
    fetchStatus();
  }, []);

  const handleStart = async () => {
    if (selectedIds.size === 0) {
      setError('Select at least one task pack');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/mcp/start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-MCPIFY-TOKEN': token,
        },
        body: JSON.stringify({
          packIds: Array.from(selectedIds),
          port: port > 0 ? port : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || data.details || 'Failed to start MCP server');
      }
      await fetchStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleStop = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/mcp/stop', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-MCPIFY-TOKEN': token,
        },
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || data.details || 'Failed to stop MCP server');
      }
      await fetchStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const togglePack = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    setSelectedIds(new Set(packs.map((p) => p.id)));
  };

  const selectNone = () => {
    setSelectedIds(new Set());
  };

  return (
    <div>
      <div className="card">
        <h2>MCP Server (HTTP/SSE)</h2>
        <p style={{ marginBottom: '16px', color: 'var(--text-secondary)', fontSize: '14px' }}>
          Start an MCP server with selected task packs. Clients connect via Streamable HTTP (POST/GET) or SSE.
        </p>

        {error && <div className="error">{error}</div>}

        {status?.running ? (
          <div>
            <div
              style={{
                marginBottom: '16px',
                padding: '16px',
                background: 'rgba(34, 197, 94, 0.1)',
                border: '1px solid rgba(34, 197, 94, 0.2)',
                borderRadius: '10px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
                <span
                  style={{
                    width: '10px',
                    height: '10px',
                    borderRadius: '50%',
                    backgroundColor: 'var(--status-ready)',
                  }}
                />
                <strong style={{ color: 'var(--status-ready)' }}>Server Running</strong>
              </div>
              <div style={{ marginBottom: '8px' }}>
                <strong>URL:</strong>{' '}
                <a
                  href={status.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: 'var(--accent-orange)' }}
                >
                  {status.url}
                </a>
              </div>
              <div style={{ marginBottom: '8px' }}>
                <strong>Exposed Packs:</strong> {(status.packIds ?? []).join(', ')}
              </div>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                Server is ready. Send MCP requests directly to this URL.
              </div>
            </div>
            <button className="btn-secondary" onClick={handleStop} disabled={loading}>
              {loading ? 'Stopping...' : 'Stop MCP Server'}
            </button>
          </div>
        ) : (
          <div>
            <div style={{ marginBottom: '16px' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <strong>Port:</strong>
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={port}
                  onChange={(e) => setPort(parseInt(e.target.value, 10) || 3340)}
                  style={{ width: '100px' }}
                />
              </label>
            </div>

            {/* Ready Flows from Conversations */}
            {readyFlows.length > 0 && (
              <div style={{ marginBottom: '20px' }}>
                <div style={{ marginBottom: '12px' }}>
                  <strong>Ready Flows from Conversations:</strong>
                </div>
                <div className="pack-list" style={{ maxHeight: '160px', overflowY: 'auto' }}>
                  {readyFlows.map((conv) => (
                    <label
                      key={conv.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '12px',
                        padding: '10px 0',
                        cursor: 'pointer',
                        borderBottom: '1px solid var(--border-subtle)',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={conv.packId ? selectedIds.has(conv.packId) : false}
                        onChange={() => conv.packId && togglePack(conv.packId)}
                      />
                      <div style={{ flex: 1 }}>
                        <span style={{ fontWeight: 500 }}>{conv.title}</span>
                        {conv.description && (
                          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                            {conv.description}
                          </div>
                        )}
                      </div>
                      <span
                        className="status-badge success"
                        style={{ fontSize: '10px', padding: '2px 6px' }}
                      >
                        Ready
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {/* All Task Packs */}
            <div style={{ marginBottom: '12px' }}>
              <strong>All Task Packs:</strong>
              <div style={{ marginTop: '8px', display: 'flex', gap: '8px' }}>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={selectAll}
                  style={{ padding: '6px 12px', fontSize: '12px' }}
                >
                  Select All
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={selectNone}
                  style={{ padding: '6px 12px', fontSize: '12px' }}
                >
                  Select None
                </button>
              </div>
            </div>
            <div className="pack-list" style={{ maxHeight: '240px', overflowY: 'auto', marginBottom: '16px' }}>
              {packs.length === 0 ? (
                <div className="loading">No task packs available</div>
              ) : (
                packs.map((pack) => (
                  <label
                    key={pack.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '12px',
                      padding: '10px 0',
                      cursor: 'pointer',
                      borderBottom: '1px solid var(--border-subtle)',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={selectedIds.has(pack.id)}
                      onChange={() => togglePack(pack.id)}
                    />
                    <span style={{ fontWeight: 500 }}>{pack.name}</span>
                    <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                      {pack.id} • v{pack.version}
                    </span>
                  </label>
                ))
              )}
            </div>
            <button
              className="btn-primary"
              onClick={handleStart}
              disabled={loading || selectedIds.size === 0}
            >
              {loading ? 'Starting...' : 'Start MCP Server'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default MCPServerView;
