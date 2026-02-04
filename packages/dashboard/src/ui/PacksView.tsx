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
        'X-MCPIFY-TOKEN': token,
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
          'X-MCPIFY-TOKEN': token,
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
                  <button
                    className="btn-secondary"
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingPackId(pack.id);
                    }}
                    style={{ marginLeft: '12px', padding: '6px 12px', fontSize: '12px' }}
                  >
                    Edit
                  </button>
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
