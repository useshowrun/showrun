import React, { useState } from 'react';

interface NewPackModalProps {
  onClose: () => void;
  onCreate: (pack: { id: string; name: string; version: string; description: string }) => Promise<void>;
  token: string;
}

function NewPackModal({ onClose, onCreate }: NewPackModalProps) {
  const [form, setForm] = useState({
    id: '',
    name: '',
    version: '0.1.0',
    description: '',
  });
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setError(null);

    try {
      await onCreate(form);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0,0,0,0.7)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        className="card"
        style={{ maxWidth: '500px', width: '90%' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2>Create New JSON Task Pack</h2>
        {error && <div className="error">{error}</div>}
        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: '12px' }}>
            <label>
              <strong>Pack ID:</strong> (required)
            </label>
            <input
              type="text"
              value={form.id}
              onChange={(e) => setForm({ ...form, id: e.target.value })}
              required
              pattern="[a-zA-Z0-9._-]+"
              style={{ width: '100%', padding: '8px' }}
              placeholder="example.site.collector"
            />
            <small>Only alphanumeric, dots, underscores, and hyphens</small>
          </div>
          <div style={{ marginBottom: '12px' }}>
            <label>
              <strong>Name:</strong> (required)
            </label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
              style={{ width: '100%', padding: '8px' }}
              placeholder="Example Collector"
            />
          </div>
          <div style={{ marginBottom: '12px' }}>
            <label>
              <strong>Version:</strong> (required)
            </label>
            <input
              type="text"
              value={form.version}
              onChange={(e) => setForm({ ...form, version: e.target.value })}
              required
              style={{ width: '100%', padding: '8px' }}
              placeholder="0.1.0"
            />
          </div>
          <div style={{ marginBottom: '12px' }}>
            <label>
              <strong>Description:</strong>
            </label>
            <textarea
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              style={{ width: '100%', padding: '8px', minHeight: '60px' }}
              placeholder="What this pack does..."
            />
          </div>
          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
            <button className="btn-secondary" type="button" onClick={onClose} disabled={creating}>
              Cancel
            </button>
            <button className="btn-primary" type="submit" disabled={creating}>
              {creating ? 'Creating...' : 'Create Pack'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default NewPackModal;
