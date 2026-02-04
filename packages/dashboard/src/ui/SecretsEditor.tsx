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
          'X-MCPIFY-TOKEN': token,
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
          'X-MCPIFY-TOKEN': token,
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
      // Get current secrets and add new one
      const newDefinitions = [
        ...secrets.map((s) => ({ name: s.name, description: s.description, required: s.required })),
        { name: newSecretName.trim(), description: newSecretDescription.trim() || undefined, required: newSecretRequired },
      ];

      const res = await fetch(`/api/packs/${packId}/secrets-schema`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-MCPIFY-TOKEN': token,
        },
        body: JSON.stringify({ secrets: newDefinitions }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to add secret definition');
      }

      // If a value was provided, set it immediately
      if (newSecretValue.trim()) {
        const valueRes = await fetch(`/api/packs/${packId}/secrets/${encodeURIComponent(newSecretName.trim())}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'X-MCPIFY-TOKEN': token,
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
      // Remove from definitions
      const newDefinitions = secrets
        .filter((s) => s.name !== name)
        .map((s) => ({ name: s.name, description: s.description, required: s.required }));

      const res = await fetch(`/api/packs/${packId}/secrets-schema`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-MCPIFY-TOKEN': token,
        },
        body: JSON.stringify({ secrets: newDefinitions }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to remove secret definition');
      }

      // Also remove the value if it exists
      const secret = secrets.find((s) => s.name === name);
      if (secret?.hasValue) {
        await fetch(`/api/packs/${packId}/secrets/${encodeURIComponent(name)}`, {
          method: 'DELETE',
          headers: { 'X-MCPIFY-TOKEN': token },
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
    return <div style={{ padding: '12px', color: '#666' }}>Loading secrets...</div>;
  }

  return (
    <div>
      {error && (
        <div style={{ background: '#f8d7da', padding: '8px 12px', borderRadius: '4px', marginBottom: '12px', color: '#721c24' }}>
          {error}
        </div>
      )}

      {secrets.length === 0 ? (
        <div style={{ padding: '12px', color: '#666', fontStyle: 'italic' }}>
          No secrets defined. Add secrets to store credentials securely.
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '12px' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #ddd' }}>
              <th style={{ textAlign: 'left', padding: '8px' }}>Name</th>
              <th style={{ textAlign: 'left', padding: '8px' }}>Description</th>
              <th style={{ textAlign: 'center', padding: '8px' }}>Required</th>
              <th style={{ textAlign: 'left', padding: '8px' }}>Value</th>
              <th style={{ textAlign: 'center', padding: '8px' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {secrets.map((secret) => (
              <tr key={secret.name} style={{ borderBottom: '1px solid #eee' }}>
                <td style={{ padding: '8px', fontFamily: 'monospace' }}>
                  {secret.name}
                </td>
                <td style={{ padding: '8px', color: '#666', fontSize: '13px' }}>
                  {secret.description || '-'}
                </td>
                <td style={{ padding: '8px', textAlign: 'center' }}>
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
                        style={{ flex: 1, padding: '4px 8px', fontFamily: 'monospace' }}
                        autoFocus
                      />
                      <button
                        onClick={() => handleSetSecret(secret.name)}
                        disabled={saving || !secretValue}
                        style={{ padding: '4px 8px' }}
                      >
                        Save
                      </button>
                      <button
                        onClick={() => {
                          setEditingSecret(null);
                          setSecretValue('');
                        }}
                        style={{ padding: '4px 8px' }}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <span style={{ fontFamily: 'monospace', color: secret.hasValue ? '#28a745' : '#dc3545' }}>
                      {secret.hasValue ? secret.preview || '********' : '(not set)'}
                    </span>
                  )}
                </td>
                <td style={{ padding: '8px', textAlign: 'center' }}>
                  {editingSecret !== secret.name && (
                    <div style={{ display: 'flex', gap: '4px', justifyContent: 'center' }}>
                      <button
                        onClick={() => {
                          setEditingSecret(secret.name);
                          setSecretValue('');
                        }}
                        disabled={saving}
                        style={{ padding: '4px 8px', fontSize: '12px' }}
                      >
                        {secret.hasValue ? 'Update' : 'Set'}
                      </button>
                      {secret.hasValue && (
                        <button
                          onClick={() => handleDeleteSecret(secret.name)}
                          disabled={saving}
                          style={{ padding: '4px 8px', fontSize: '12px', color: '#dc3545' }}
                        >
                          Clear
                        </button>
                      )}
                      <button
                        onClick={() => handleRemoveSecretDefinition(secret.name)}
                        disabled={saving}
                        style={{ padding: '4px 8px', fontSize: '12px', color: '#dc3545' }}
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
        <div style={{ background: '#f8f9fa', padding: '12px', borderRadius: '4px', marginTop: '12px' }}>
          <h4 style={{ margin: '0 0 12px 0' }}>Add Secret</h4>
          <div style={{ display: 'grid', gap: '12px' }}>
            <div>
              <label style={{ display: 'block', marginBottom: '4px', fontWeight: 'bold' }}>
                Name (UPPER_SNAKE_CASE)
              </label>
              <input
                type="text"
                value={newSecretName}
                onChange={(e) => setNewSecretName(e.target.value.toUpperCase())}
                placeholder="API_KEY, PASSWORD, etc."
                style={{ width: '100%', padding: '8px', fontFamily: 'monospace' }}
              />
            </div>
            <div>
              <label style={{ display: 'block', marginBottom: '4px', fontWeight: 'bold' }}>
                Value
              </label>
              <input
                type="text"
                value={newSecretValue}
                onChange={(e) => setNewSecretValue(e.target.value)}
                placeholder="Enter the secret value"
                style={{ width: '100%', padding: '8px', fontFamily: 'monospace' }}
              />
            </div>
            <div>
              <label style={{ display: 'block', marginBottom: '4px', fontWeight: 'bold' }}>
                Description (optional)
              </label>
              <input
                type="text"
                value={newSecretDescription}
                onChange={(e) => setNewSecretDescription(e.target.value)}
                placeholder="What is this secret used for?"
                style={{ width: '100%', padding: '8px' }}
              />
            </div>
            <div>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  type="checkbox"
                  checked={newSecretRequired}
                  onChange={(e) => setNewSecretRequired(e.target.checked)}
                />
                Required
              </label>
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button onClick={handleAddSecretDefinition} disabled={saving || !newSecretName}>
                Add Secret
              </button>
              <button
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
        <button onClick={() => setShowAddForm(true)} disabled={saving}>
          + Add Secret
        </button>
      )}

      <div style={{ marginTop: '16px', padding: '12px', background: '#e7f3ff', borderRadius: '4px', fontSize: '13px' }}>
        <strong>Usage:</strong> Reference secrets in your flow using{' '}
        <code style={{ background: '#f0f0f0', padding: '2px 4px', borderRadius: '2px' }}>
          {'{{secret.SECRET_NAME}}'}
        </code>
        <br />
        <span style={{ color: '#666' }}>
          Secrets are stored in <code>.secrets.json</code> (gitignored) and never exposed to AI agents.
        </span>
      </div>
    </div>
  );
}

export default SecretsEditor;
