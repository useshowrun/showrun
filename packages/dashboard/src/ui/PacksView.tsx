import React, { useState } from 'react';
import type { Socket } from 'socket.io-client';
import NewPackModal from './NewPackModal.js';
import PackEditor from './PackEditor.js';

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
  const [selectedPack, setSelectedPack] = useState<Pack | null>(null);
  const [editingPackId, setEditingPackId] = useState<string | null>(null);
  const [showNewModal, setShowNewModal] = useState(false);
  const [inputsJson, setInputsJson] = useState('{}');
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [packsList, setPacksList] = useState(packs);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // Sync packsList with packs prop when it changes
  React.useEffect(() => {
    setPacksList(packs);
  }, [packs]);

  // Update packs list when socket emits update
  React.useEffect(() => {
    socket.on('packs:updated', () => {
      // Reload packs by fetching from API
      fetch('/api/packs')
        .then((res) => res.json())
        .then((data) => {
          setPacksList(data as Pack[]);
          // Also update parent's packs state if needed
        })
        .catch(console.error);
    });
    return () => {
      socket.off('packs:updated');
    };
  }, [socket]);

  const handleCreatePack = async (packData: {
    id: string;
    name: string;
    version: string;
    description: string;
  }) => {
    const res = await fetch('/api/packs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-SHOWRUN-TOKEN': token,
      },
      body: JSON.stringify(packData),
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Failed to create pack');
    }

    const newPack = await res.json();
    setPacksList([...packsList, newPack]);
    setEditingPackId(newPack.id);
  };

  const handleRun = async (packId: string) => {
    if (!selectedPack) return;

    try {
      // Validate JSON
      JSON.parse(inputsJson);
    } catch (e) {
      setError('Invalid JSON in inputs');
      return;
    }

    setIsRunning(true);
    setError(null);

    try {
      const res = await fetch('/api/runs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-SHOWRUN-TOKEN': token,
        },
        body: JSON.stringify({
          packId: packId || selectedPack.id,
          inputs: JSON.parse(inputsJson),
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to start run');
      }

      const { runId } = await res.json();
      console.log('Run started:', runId);
      setInputsJson('{}'); // Reset inputs
      onRun(packId || selectedPack.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsRunning(false);
    }
  };

  const handleDeletePack = async (packId: string) => {
    setIsDeleting(true);
    setError(null);

    try {
      const res = await fetch(`/api/packs/${packId}`, {
        method: 'DELETE',
        headers: {
          'X-SHOWRUN-TOKEN': token,
        },
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to delete pack');
      }

      // Remove from local state
      setPacksList((prev) => prev.filter((p) => p.id !== packId));
      if (selectedPack?.id === packId) {
        setSelectedPack(null);
      }
      setDeleteConfirm(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsDeleting(false);
    }
  };

  if (editingPackId) {
    return (
      <PackEditor
        packId={editingPackId}
        packs={packsList}
        socket={socket}
        token={token}
        onBack={() => setEditingPackId(null)}
        onRun={(packId) => {
          setEditingPackId(null);
          onRun(packId);
        }}
      />
    );
  }

  return (
    <div>
      {showNewModal && (
        <NewPackModal
          onClose={() => setShowNewModal(false)}
          onCreate={handleCreatePack}
          token={token}
        />
      )}
      {deleteConfirm && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.7)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
          onClick={() => !isDeleting && setDeleteConfirm(null)}
        >
          <div
            className="card"
            style={{
              width: '400px',
              maxWidth: '90vw',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ marginTop: 0, color: 'var(--error)' }}>Delete Pack</h3>
            <p style={{ color: 'var(--text-secondary)' }}>
              Are you sure you want to delete <strong>{deleteConfirm}</strong>?
            </p>
            <p style={{ color: 'var(--text-muted)', fontSize: '13px' }}>
              This will permanently delete the pack directory and all its files. This action cannot be undone.
            </p>
            {error && <div className="error" style={{ marginBottom: '16px' }}>{error}</div>}
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
              <button
                className="btn-secondary"
                onClick={() => setDeleteConfirm(null)}
                disabled={isDeleting}
              >
                Cancel
              </button>
              <button
                className="btn-primary"
                onClick={() => handleDeletePack(deleteConfirm)}
                disabled={isDeleting}
                style={{
                  backgroundColor: 'var(--error)',
                  borderColor: 'var(--error)',
                }}
              >
                {isDeleting ? 'Deleting...' : 'Delete Pack'}
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <h2 style={{ margin: 0 }}>Available Task Packs</h2>
          <button className="btn-primary" onClick={() => setShowNewModal(true)}>New JSON Pack</button>
        </div>
        <div className="pack-list">
          {packsList.length === 0 ? (
            <div className="loading">No task packs found</div>
          ) : (
            packsList.map((pack) => (
            <div
              key={pack.id}
              className={`pack-item ${selectedPack?.id === pack.id ? 'selected' : ''}`}
              onClick={() => setSelectedPack(pack)}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
                <div style={{ flex: 1 }}>
                  <h3>{pack.name}</h3>
                  <div className="meta">
                    {pack.id} • v{pack.version}
                    {pack.kind === 'json-dsl' && (
                      <span style={{ marginLeft: '8px', color: '#007bff', fontSize: '11px' }}>[JSON]</span>
                    )}
                  </div>
                  <div className="description">
                    {pack.description || 'No description'}
                  </div>
                </div>
                {pack.kind === 'json-dsl' && (
                  <div style={{ display: 'flex', gap: '8px', marginLeft: '12px' }}>
                    <button
                      className="btn-secondary"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingPackId(pack.id);
                      }}
                      style={{ padding: '6px 12px', fontSize: '12px' }}
                    >
                      Edit
                    </button>
                    <button
                      className="btn-secondary"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteConfirm(pack.id);
                      }}
                      style={{
                        padding: '6px 12px',
                        fontSize: '12px',
                        color: 'var(--error)',
                        borderColor: 'var(--error)',
                      }}
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))
          )}
        </div>
      </div>

      {selectedPack && (
        <div className="card">
          <h2>Run: {selectedPack.name}</h2>
          {error && <div className="error">{error}</div>}
          <div className="run-form">
            <label>
              <strong>Inputs (JSON):</strong>
            </label>
            <textarea
              value={inputsJson}
              onChange={(e) => setInputsJson((e.target as HTMLTextAreaElement).value)}
              placeholder='{"key": "value"}'
            />
            <button className="btn-primary" onClick={() => handleRun(selectedPack.id)} disabled={isRunning}>
              {isRunning ? 'Running...' : 'Run Task Pack'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default PacksView;
