import React, { useState, useEffect } from 'react';
import type { Socket } from 'socket.io-client';

interface Run {
  runId: string;
  packId: string;
  packName: string;
  status: 'queued' | 'running' | 'success' | 'failed';
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  runDir?: string;
  eventsPath?: string;
  artifactsDir?: string;
  collectibles?: Record<string, unknown>;
  meta?: {
    url?: string;
    durationMs: number;
    notes?: string;
  };
  error?: string;
  conversationId?: string;
  source?: 'dashboard' | 'mcp' | 'cli' | 'agent';
}

interface RunEvent {
  timestamp: string;
  type: string;
  data: any;
}

interface RunsViewProps {
  runs: Run[];
  socket: Socket;
}

const STATUS_COLORS: Record<string, string> = {
  running: 'var(--status-running)',
  success: 'var(--status-ready)',
  failed: 'var(--status-error)',
  queued: 'var(--text-muted)',
};

function formatDate(timestamp: number) {
  return new Date(timestamp).toLocaleString();
}

function formatDuration(ms?: number) {
  if (!ms) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function getSourceLabel(source?: string) {
  switch (source) {
    case 'dashboard': return 'Dashboard';
    case 'mcp': return 'MCP';
    case 'cli': return 'CLI';
    case 'agent': return 'Agent';
    default: return 'Unknown';
  }
}

function RunsView({ runs, socket }: RunsViewProps) {
  const [selectedRun, setSelectedRun] = useState<Run | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [sourceFilter, setSourceFilter] = useState<string>('all');

  // Auto-select first run
  useEffect(() => {
    if (!selectedRun && runs.length > 0) {
      setSelectedRun(runs[0]);
    }
  }, [runs]);

  useEffect(() => {
    if (!selectedRun) { setEvents([]); return; }
    const ch = `runs:events:${selectedRun.runId}`;
    socket.on(ch, (event: RunEvent) => setEvents((prev) => [...prev, event]));
    return () => { socket.off(ch); };
  }, [selectedRun, socket]);

  // When run is re-selected reset events
  const handleSelect = (run: Run) => {
    setEvents([]);
    setSelectedRun(run);
  };

  const filteredRuns = sourceFilter === 'all' ? runs : runs.filter((r) => r.source === sourceFilter);

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>

      {/* ── Left panel: list ── */}
      <div style={{
        width: 300,
        minWidth: 220,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        borderRight: '1px solid var(--border-subtle)',
        overflow: 'hidden',
      }}>
        {/* Header + filter */}
        <div style={{
          padding: '16px',
          borderBottom: '1px solid var(--border-subtle)',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
        }}>
          <div style={{ fontWeight: 700, fontSize: '15px', color: 'var(--text-primary)' }}>Runs</div>
          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            style={{ width: '100%' }}
          >
            <option value="all">All Sources</option>
            <option value="dashboard">Dashboard</option>
            <option value="mcp">MCP</option>
            <option value="cli">CLI</option>
            <option value="agent">Agent</option>
          </select>
        </div>

        {/* Run list */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px' }}>
          {filteredRuns.length === 0 ? (
            <div className="empty-state" style={{ padding: '40px 16px' }}>
              <div className="empty-state-title">No runs yet</div>
              <div className="empty-state-description">Runs appear here when you execute task packs.</div>
            </div>
          ) : (
            filteredRuns.map((run) => (
              <div
                key={run.runId}
                onClick={() => handleSelect(run)}
                style={{
                  padding: '12px',
                  borderRadius: '8px',
                  marginBottom: '4px',
                  cursor: 'pointer',
                  backgroundColor: selectedRun?.runId === run.runId ? 'var(--bg-card-active)' : 'transparent',
                  border: selectedRun?.runId === run.runId
                    ? '1px solid var(--border-accent)'
                    : '1px solid transparent',
                  transition: 'all 0.12s',
                }}
                onMouseEnter={(e) => {
                  if (selectedRun?.runId !== run.runId) {
                    (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--bg-card)';
                  }
                }}
                onMouseLeave={(e) => {
                  if (selectedRun?.runId !== run.runId) {
                    (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent';
                  }
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                  <span style={{ fontWeight: 600, fontSize: '13px', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '160px' }}>
                    {run.packName}
                  </span>
                  <span style={{
                    fontSize: '10px',
                    fontWeight: 600,
                    padding: '2px 6px',
                    borderRadius: '4px',
                    textTransform: 'uppercase',
                    color: STATUS_COLORS[run.status] || 'var(--text-muted)',
                    backgroundColor: `${STATUS_COLORS[run.status]}18` || 'transparent',
                    flexShrink: 0,
                  }}>
                    {run.status}
                  </span>
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'flex', gap: '8px' }}>
                  <span>{formatDuration(run.durationMs)}</span>
                  <span>{new Date(run.createdAt).toLocaleDateString()}</span>
                  {run.source && <span style={{ color: 'var(--accent-orange)', opacity: 0.8 }}>{getSourceLabel(run.source)}</span>}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* ── Right panel: detail ── */}
      <div style={{ flex: 1, overflow: 'auto', padding: '24px' }}>
        {!selectedRun ? (
          <div className="empty-state" style={{ marginTop: '60px' }}>
            <div className="empty-state-title">Select a run</div>
            <div className="empty-state-description">Click a run on the left to view its details.</div>
          </div>
        ) : (
          <>
            {/* Detail header */}
            <div style={{ marginBottom: '24px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '4px' }}>
                <h2 style={{ margin: 0, fontSize: '18px' }}>{selectedRun.packName}</h2>
                <span className={`status-badge ${selectedRun.status}`}>{selectedRun.status}</span>
              </div>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                {selectedRun.runId} · {getSourceLabel(selectedRun.source)}
              </div>
            </div>

            {/* Info grid */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '24px' }}>
              {[
                ['Created', formatDate(selectedRun.createdAt)],
                ['Duration', formatDuration(selectedRun.durationMs)],
                ...(selectedRun.startedAt ? [['Started', formatDate(selectedRun.startedAt)]] : []),
                ...(selectedRun.finishedAt ? [['Finished', formatDate(selectedRun.finishedAt)]] : []),
                ...(selectedRun.meta?.url ? [['URL', selectedRun.meta.url]] : []),
                ...(selectedRun.meta?.notes ? [['Notes', selectedRun.meta.notes]] : []),
              ].map(([label, value]) => (
                <div key={label} style={{ background: 'var(--bg-card)', padding: '12px 14px', borderRadius: '8px', border: '1px solid var(--border-subtle)' }}>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
                  <div style={{ fontSize: '13px', color: 'var(--text-primary)', fontFamily: typeof value === 'string' && value.startsWith('http') ? 'var(--font-mono)' : undefined, wordBreak: 'break-all' }}>{value as string}</div>
                </div>
              ))}
            </div>

            {/* Error */}
            {selectedRun.error && (
              <div className="error" style={{ marginBottom: '24px' }}>
                <strong>Error:</strong> <code>{selectedRun.error}</code>
              </div>
            )}

            {/* Collectibles */}
            {selectedRun.collectibles && Object.keys(selectedRun.collectibles).length > 0 && (
              <div style={{ marginBottom: '24px' }}>
                <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '10px' }}>Collectibles</div>
                <div className="events-stream">
                  <pre style={{ margin: 0 }}>{JSON.stringify(selectedRun.collectibles, null, 2)}</pre>
                </div>
              </div>
            )}

            {/* Paths */}
            {(selectedRun.runDir || selectedRun.eventsPath || selectedRun.artifactsDir) && (
              <div style={{ marginBottom: '24px' }}>
                <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '10px' }}>Paths</div>
                <div className="run-detail-info">
                  {selectedRun.runDir && <p><strong>Run Dir:</strong> <code>{selectedRun.runDir}</code></p>}
                  {selectedRun.eventsPath && <p><strong>Events:</strong> <code>{selectedRun.eventsPath}</code></p>}
                  {selectedRun.artifactsDir && <p><strong>Artifacts:</strong> <code>{selectedRun.artifactsDir}</code></p>}
                </div>
              </div>
            )}

            {/* Live events */}
            <div>
              <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '10px' }}>Live Events</div>
              <div className="events-stream">
                {events.length === 0 ? (
                  <div className="event-line info">
                    {selectedRun.status === 'running' ? 'Waiting for events...' : 'No events captured'}
                  </div>
                ) : (
                  events.map((event, idx) => (
                    <div key={idx} className={`event-line ${event.type === 'error' ? 'error' : event.type === 'run_finished' && event.data?.success ? 'success' : 'info'}`}>
                      [{event.timestamp}] {event.type}: {JSON.stringify(event.data)}
                    </div>
                  ))
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default RunsView;
