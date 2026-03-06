import React, { useState } from 'react';
import type { Socket } from 'socket.io-client';
import NewPackModal from './NewPackModal.js';
import PackEditor from './PackEditor.js';
import RegistryPublishModal from './RegistryPublishModal.js';

interface Pack {
  id: string;
  name: string;
  version: string;
  description: string;
  inputs: Record<string, any>;
  collectibles: Array<{ name: string; type: string; description?: string }>;
  path: string;
  kind?: string;
}

interface PacksViewProps {
  packs: Pack[];
  socket: Socket;
  token: string;
  onRun: (packId: string) => void;
}

function PacksView({ packs, socket, token, onRun }: PacksViewProps) {
  const [selectedPackId, setSelectedPackId] = useState<string | null>(null);
  const [showNewModal, setShowNewModal] = useState(false);
  const [packsList, setPacksList] = useState(packs);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [publishPackId, setPublishPackId] = useState<string | null>(null);
  const [inputsJson, setInputsJson] = useState('{}');
  const [isRunning, setIsRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  React.useEffect(() => {
    setPacksList(packs);
  }, [packs]);

  React.useEffect(() => {
    socket.on('packs:updated', () => {
      fetch('/api/packs')
        .then((res) => res.json())
        .then((data) => setPacksList(data as Pack[]))
        .catch(console.error);
    });
    return () => { socket.off('packs:updated'); };
  }, [socket]);

  const selectedPack = packsList.find((p) => p.id === selectedPackId) ?? null;

  const handleCreatePack = async (packData: {
    id: string; name: string; version: string; description: string;
  }) => {
    const res = await fetch('/api/packs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-SHOWRUN-TOKEN': token },
      body: JSON.stringify(packData),
    });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Failed to create pack');
    }
    const newPack = await res.json();
    setPacksList((prev) => [...prev, newPack]);
    setSelectedPackId(newPack.id);
  };

  const handleRun = async (packId: string) => {
    try { JSON.parse(inputsJson); } catch {
      setRunError('Invalid JSON in inputs');
      return;
    }
    setIsRunning(true);
    setRunError(null);
    try {
      const res = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-SHOWRUN-TOKEN': token },
        body: JSON.stringify({ packId, inputs: JSON.parse(inputsJson) }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to start run');
      }
      setInputsJson('{}');
      onRun(packId);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsRunning(false);
    }
  };

  const handleDeletePack = async (packId: string) => {
    setIsDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/packs/${packId}`, {
        method: 'DELETE',
        headers: { 'X-SHOWRUN-TOKEN': token },
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to delete pack');
      }
      setPacksList((prev) => prev.filter((p) => p.id !== packId));
      if (selectedPackId === packId) setSelectedPackId(null);
      setDeleteConfirm(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* Modals */}
      {showNewModal && (
        <NewPackModal onClose={() => setShowNewModal(false)} onCreate={handleCreatePack} token={token} />
      )}
      {deleteConfirm && (
        <div
          style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
          onClick={() => !isDeleting && setDeleteConfirm(null)}
        >
          <div className="card" style={{ width: '400px', maxWidth: '90vw' }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0, color: 'var(--error)' }}>Delete Pack</h3>
            <p style={{ color: 'var(--text-secondary)' }}>
              Are you sure you want to delete <strong>{deleteConfirm}</strong>?
            </p>
            <p style={{ color: 'var(--text-muted)', fontSize: '13px' }}>
              This will permanently delete the pack directory and all its files. This action cannot be undone.
            </p>
            {deleteError && <div className="error" style={{ marginBottom: '16px' }}>{deleteError}</div>}
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
              <button className="btn-secondary" onClick={() => setDeleteConfirm(null)} disabled={isDeleting}>Cancel</button>
              <button
                className="btn-primary"
                onClick={() => handleDeletePack(deleteConfirm)}
                disabled={isDeleting}
                style={{ backgroundColor: 'var(--error)', borderColor: 'var(--error)' }}
              >
                {isDeleting ? 'Deleting...' : 'Delete Pack'}
              </button>
            </div>
          </div>
        </div>
      )}
      {publishPackId && (() => {
        const pubPack = packsList.find((p) => p.id === publishPackId);
        return pubPack ? (
          <RegistryPublishModal
            packId={pubPack.id}
            packName={pubPack.name}
            packVersion={pubPack.version}
            onClose={() => setPublishPackId(null)}
          />
        ) : null;
      })()}

      {/* ── Left panel: list ── */}
      <div style={{
        width: 280,
        minWidth: 200,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        borderRight: '1px solid var(--border-subtle)',
        overflow: 'hidden',
      }}>
        <div style={{
          padding: '16px',
          borderBottom: '1px solid var(--border-subtle)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}>
          <div style={{ fontWeight: 700, fontSize: '15px', color: 'var(--text-primary)' }}>Task Packs</div>
          <button
            className="btn-primary"
            onClick={() => setShowNewModal(true)}
            style={{ padding: '5px 10px', fontSize: '12px' }}
          >
            + New
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '8px' }}>
          {packsList.length === 0 ? (
            <div className="empty-state" style={{ padding: '40px 16px' }}>
              <div className="empty-state-title">No packs yet</div>
              <div className="empty-state-description">Create a new JSON pack to get started.</div>
            </div>
          ) : (
            packsList.map((pack) => (
              <div
                key={pack.id}
                onClick={() => { setSelectedPackId(pack.id); setInputsJson('{}'); setRunError(null); }}
                style={{
                  padding: '12px',
                  borderRadius: '8px',
                  marginBottom: '4px',
                  cursor: 'pointer',
                  backgroundColor: selectedPackId === pack.id ? 'var(--bg-card-active)' : 'transparent',
                  border: selectedPackId === pack.id
                    ? '1px solid var(--border-accent)'
                    : '1px solid transparent',
                  transition: 'all 0.12s',
                }}
                onMouseEnter={(e) => {
                  if (selectedPackId !== pack.id) {
                    (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--bg-card)';
                  }
                }}
                onMouseLeave={(e) => {
                  if (selectedPackId !== pack.id) {
                    (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent';
                  }
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: '13px', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: '3px' }}>
                      {pack.name}
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'flex', gap: '4px', alignItems: 'center', flexWrap: 'wrap' }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '120px' }}>{pack.id}</span>
                      <span>·</span>
                      <span>v{pack.version}</span>
                      {pack.kind === 'json-dsl' && (
                        <span style={{ color: 'var(--accent-orange)', opacity: 0.8 }}>JSON</span>
                      )}
                    </div>
                  </div>
                  {pack.kind === 'json-dsl' && (
                    <button
                      className="btn-secondary"
                      onClick={(e) => { e.stopPropagation(); setDeleteConfirm(pack.id); }}
                      style={{ padding: '2px 6px', fontSize: '11px', color: 'var(--error)', borderColor: 'var(--error)', flexShrink: 0 }}
                      title="Delete pack"
                    >
                      ✕
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* ── Right panel: detail / editor ── */}
      <div style={{ flex: 1, overflow: 'auto', padding: '24px' }}>
        {!selectedPack ? (
          <div className="empty-state" style={{ marginTop: '60px' }}>
            <div className="empty-state-title">Select a task pack</div>
            <div className="empty-state-description">Choose a pack from the list to view or edit it.</div>
          </div>
        ) : selectedPack.kind === 'json-dsl' ? (
          <PackEditor
            packId={selectedPack.id}
            packs={packsList}
            socket={socket}
            token={token}
            onBack={() => setSelectedPackId(null)}
            onRun={(packId) => onRun(packId)}
          />
        ) : (
          <div>
            <div style={{ marginBottom: '24px' }}>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Task Pack</div>
              <h2 style={{ margin: 0, fontSize: '20px' }}>{selectedPack.name}</h2>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
                {selectedPack.id} · v{selectedPack.version}
              </div>
            </div>
            {selectedPack.description && (
              <p style={{ color: 'var(--text-secondary)', marginBottom: '24px' }}>{selectedPack.description}</p>
            )}
            <div className="card">
              <h3 style={{ marginTop: 0 }}>Run Pack</h3>
              {runError && <div className="error" style={{ marginBottom: '12px' }}>{runError}</div>}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div>
                  <label style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-secondary)', display: 'block', marginBottom: '4px' }}>
                    Inputs (JSON)
                  </label>
                  <textarea
                    value={inputsJson}
                    onChange={(e) => setInputsJson((e.target as HTMLTextAreaElement).value)}
                    placeholder='{"key": "value"}'
                    style={{ width: '100%', minHeight: '100px', fontFamily: 'var(--font-mono)', fontSize: '13px' }}
                  />
                </div>
                <button
                  className="btn-primary"
                  onClick={() => handleRun(selectedPack.id)}
                  disabled={isRunning}
                  style={{ alignSelf: 'flex-start' }}
                >
                  {isRunning ? 'Running...' : '▶ Run Pack'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default PacksView;
