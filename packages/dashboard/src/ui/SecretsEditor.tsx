import React, { useState, useEffect } from 'react';

interface SecretInfo {
  name: string;
  description?: string;
  required?: boolean;
  hasValue: boolean;
  preview?: string;
}

interface SecretsEditorProps {
  packId: string;
  token: string;
}

function SecretsEditor({ packId, token }: SecretsEditorProps) {
  const [secrets, setSecrets] = useState<SecretInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingSecret, setEditingSecret] = useState<string | null>(null);
  const [secretValue, setSecretValue] = useState('');
  const [saving, setSaving] = useState(false);

  // For adding new secret definitions
  const [showAddForm, setShowAddForm] = useState(false);
  const [newSecretName, setNewSecretName] = useState('');
  const [newSecretDescription, setNewSecretDescription] = useState('');
  const [newSecretRequired, setNewSecretRequired] = useState(false);
  const [newSecretValue, setNewSecretValue] = useState('');

  useEffect(() => {
    loadSecrets();
  }, [packId]);

  const loadSecrets = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/packs/${packId}/secrets`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to load secrets');
      }
      const data = await res.json();
      setSecrets(data.secrets || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleSetSecret = async (name: string) => {
    if (!secretValue) {
      setError('Secret value cannot be empty');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/packs/${packId}/secrets/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-SHOWRUN-TOKEN': token,
        },
        body: JSON.stringify({ value: secretValue }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to set secret');
      }

      setEditingSecret(null);
      setSecretValue('');
      await loadSecrets();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteSecret = async (name: string) => {
    if (!confirm(`Are you sure you want to remove the value for "${name}"?`)) {
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/packs/${packId}/secrets/${encodeURIComponent(name)}`, {
        method: 'DELETE',
        headers: {
          'X-SHOWRUN-TOKEN': token,
        },
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to delete secret');
      }

      await loadSecrets();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleAddSecretDefinition = async () => {
    if (!newSecretName.trim()) {
      setError('Secret name is required');
      return;
    }

    if (!/^[A-Z][A-Z0-9_]*$/.test(newSecretName)) {
      setError('Secret name should be UPPER_SNAKE_CASE (e.g., API_KEY, PASSWORD)');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const newDefinitions = [
        ...secrets.map((s) => ({ name: s.name, description: s.description, required: s.required })),
        { name: newSecretName.trim(), description: newSecretDescription.trim() || undefined, required: newSecretRequired },
      ];

      const res = await fetch(`/api/packs/${packId}/secrets-schema`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-SHOWRUN-TOKEN': token,
        },
        body: JSON.stringify({ secrets: newDefinitions }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to add secret definition');
      }

      if (newSecretValue.trim()) {
        const valueRes = await fetch(`/api/packs/${packId}/secrets/${encodeURIComponent(newSecretName.trim())}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'X-SHOWRUN-TOKEN': token,
          },
          body: JSON.stringify({ value: newSecretValue }),
        });

        if (!valueRes.ok) {
          const data = await valueRes.json().catch(() => ({}));
          throw new Error(data.error || 'Failed to set secret value');
        }
      }

      setShowAddForm(false);
      setNewSecretName('');
      setNewSecretDescription('');
      setNewSecretRequired(false);
      setNewSecretValue('');
      await loadSecrets();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleRemoveSecretDefinition = async (name: string) => {
    if (!confirm(`Are you sure you want to remove the secret definition "${name}"? This will also remove its value.`)) {
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const newDefinitions = secrets
        .filter((s) => s.name !== name)
        .map((s) => ({ name: s.name, description: s.description, required: s.required }));

      const res = await fetch(`/api/packs/${packId}/secrets-schema`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-SHOWRUN-TOKEN': token,
        },
        body: JSON.stringify({ secrets: newDefinitions }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to remove secret definition');
      }

      const secret = secrets.find((s) => s.name === name);
      if (secret?.hasValue) {
        await fetch(`/api/packs/${packId}/secrets/${encodeURIComponent(name)}`, {
          method: 'DELETE',
          headers: { 'X-SHOWRUN-TOKEN': token },
        });
      }

      await loadSecrets();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div style={{ padding: '12px', color: 'var(--text-muted)' }}>Loading secrets...</div>;
  }

  return (
    <div>
      {error && (
        <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', padding: '8px 12px', borderRadius: '6px', marginBottom: '12px', color: '#f87171' }}>
          {error}
        </div>
      )}

      {secrets.length === 0 ? (
        <div style={{ padding: '12px', color: 'var(--text-muted)', fontStyle: 'italic' }}>
          No secrets defined. Add secrets to store credentials securely.
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '12px' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid var(--border-subtle)' }}>
              <th style={{ textAlign: 'left', padding: '8px', color: 'var(--text-secondary)', fontSize: '12px', fontWeight: 600 }}>Name</th>
              <th style={{ textAlign: 'left', padding: '8px', color: 'var(--text-secondary)', fontSize: '12px', fontWeight: 600 }}>Description</th>
              <th style={{ textAlign: 'center', padding: '8px', color: 'var(--text-secondary)', fontSize: '12px', fontWeight: 600 }}>Required</th>
              <th style={{ textAlign: 'left', padding: '8px', color: 'var(--text-secondary)', fontSize: '12px', fontWeight: 600 }}>Value</th>
              <th style={{ textAlign: 'center', padding: '8px', color: 'var(--text-secondary)', fontSize: '12px', fontWeight: 600 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {secrets.map((secret) => (
              <tr key={secret.name} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                <td style={{ padding: '8px', fontFamily: 'var(--font-mono)', fontSize: '13px', color: 'var(--text-primary)' }}>
                  {secret.name}
                </td>
                <td style={{ padding: '8px', color: 'var(--text-muted)', fontSize: '13px' }}>
                  {secret.description || '—'}
                </td>
                <td style={{ padding: '8px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '13px' }}>
                  {secret.required ? 'Yes' : 'No'}
                </td>
                <td style={{ padding: '8px' }}>
                  {editingSecret === secret.name ? (
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                      <input
                        type="text"
                        value={secretValue}
                        onChange={(e) => setSecretValue(e.target.value)}
                        placeholder="Enter secret value"
                        style={{ flex: 1, padding: '4px 8px', fontFamily: 'var(--font-mono)' }}
                        autoFocus
                      />
                      <button
                        className="btn-primary"
                        onClick={() => handleSetSecret(secret.name)}
                        disabled={saving || !secretValue}
                        style={{ padding: '4px 10px', fontSize: '12px' }}
                      >
                        Save
                      </button>
                      <button
                        className="btn-secondary"
                        onClick={() => { setEditingSecret(null); setSecretValue(''); }}
                        style={{ padding: '4px 10px', fontSize: '12px' }}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: '13px', color: secret.hasValue ? 'var(--status-ready)' : 'var(--status-error)' }}>
                      {secret.hasValue ? secret.preview || '••••••••' : '(not set)'}
                    </span>
                  )}
                </td>
                <td style={{ padding: '8px', textAlign: 'center' }}>
                  {editingSecret !== secret.name && (
                    <div style={{ display: 'flex', gap: '4px', justifyContent: 'center' }}>
                      <button
                        className="btn-secondary"
                        onClick={() => { setEditingSecret(secret.name); setSecretValue(''); }}
                        disabled={saving}
                        style={{ padding: '4px 8px', fontSize: '12px' }}
                      >
                        {secret.hasValue ? 'Update' : 'Set'}
                      </button>
                      {secret.hasValue && (
                        <button
                          className="btn-secondary"
                          onClick={() => handleDeleteSecret(secret.name)}
                          disabled={saving}
                          style={{ padding: '4px 8px', fontSize: '12px', color: 'var(--error)', borderColor: 'var(--error)' }}
                        >
                          Clear
                        </button>
                      )}
                      <button
                        className="btn-secondary"
                        onClick={() => handleRemoveSecretDefinition(secret.name)}
                        disabled={saving}
                        style={{ padding: '4px 8px', fontSize: '12px', color: 'var(--error)', borderColor: 'var(--error)' }}
                        title="Remove secret definition"
                      >
                        Remove
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showAddForm ? (
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', padding: '16px', borderRadius: '8px', marginTop: '12px' }}>
          <h4 style={{ margin: '0 0 12px 0', fontSize: '14px', color: 'var(--text-primary)' }}>Add Secret</h4>
          <div style={{ display: 'grid', gap: '12px' }}>
            <div>
              <label style={{ display: 'block', marginBottom: '4px', fontSize: '12px', fontWeight: 500, color: 'var(--text-secondary)' }}>
                Name (UPPER_SNAKE_CASE)
              </label>
              <input
                type="text"
                value={newSecretName}
                onChange={(e) => setNewSecretName(e.target.value.toUpperCase())}
                placeholder="API_KEY, PASSWORD, etc."
                style={{ width: '100%', fontFamily: 'var(--font-mono)' }}
              />
            </div>
            <div>
              <label style={{ display: 'block', marginBottom: '4px', fontSize: '12px', fontWeight: 500, color: 'var(--text-secondary)' }}>
                Value
              </label>
              <input
                type="text"
                value={newSecretValue}
                onChange={(e) => setNewSecretValue(e.target.value)}
                placeholder="Enter the secret value"
                style={{ width: '100%', fontFamily: 'var(--font-mono)' }}
              />
            </div>
            <div>
              <label style={{ display: 'block', marginBottom: '4px', fontSize: '12px', fontWeight: 500, color: 'var(--text-secondary)' }}>
                Description (optional)
              </label>
              <input
                type="text"
                value={newSecretDescription}
                onChange={(e) => setNewSecretDescription(e.target.value)}
                placeholder="What is this secret used for?"
                style={{ width: '100%' }}
              />
            </div>
            <div>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-secondary)', fontSize: '13px' }}>
                <input
                  type="checkbox"
                  checked={newSecretRequired}
                  onChange={(e) => setNewSecretRequired(e.target.checked)}
                />
                Required
              </label>
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button className="btn-primary" onClick={handleAddSecretDefinition} disabled={saving || !newSecretName}>
                Add Secret
              </button>
              <button
                className="btn-secondary"
                onClick={() => {
                  setShowAddForm(false);
                  setNewSecretName('');
                  setNewSecretDescription('');
                  setNewSecretRequired(false);
                  setNewSecretValue('');
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : (
        <button className="btn-secondary" onClick={() => setShowAddForm(true)} disabled={saving}>
          + Add Secret
        </button>
      )}

      <div style={{ marginTop: '16px', padding: '12px 14px', background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: '8px', fontSize: '13px', color: 'var(--text-secondary)' }}>
        <strong style={{ color: 'var(--text-primary)' }}>Usage:</strong> Reference secrets in your flow using{' '}
        <code style={{ background: 'var(--bg-card-active)', padding: '2px 5px', borderRadius: '3px', fontFamily: 'var(--font-mono)', fontSize: '12px' }}>
          {'{{secret.SECRET_NAME}}'}
        </code>
        <br />
        <span style={{ color: 'var(--text-muted)' }}>
          Secrets are stored in <code style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}>.secrets.json</code> (gitignored) and never exposed to AI agents.
        </span>
      </div>
    </div>
  );
}

export default SecretsEditor;
