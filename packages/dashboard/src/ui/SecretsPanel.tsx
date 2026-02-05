import React, { useState, useEffect } from 'react';

interface SecretInfo {
  name: string;
  description?: string;
  required?: boolean;
  hasValue: boolean;
  preview?: string;
}

interface SecretsPanelProps {
  packId: string;
  token: string;
  onSecretsUpdated?: () => void;
}

export default function SecretsPanel({ packId, token, onSecretsUpdated }: SecretsPanelProps) {
  const [secrets, setSecrets] = useState<SecretInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingSecret, setEditingSecret] = useState<string | null>(null);
  const [secretValue, setSecretValue] = useState('');
  const [saving, setSaving] = useState(false);

  const loadSecrets = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/packs/${encodeURIComponent(packId)}/secrets`, {
        headers: {
          'x-showrun-token': token,
        },
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }
      const data = await response.json();
      setSecrets(data.secrets || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSecrets();
  }, [packId, token]);

  const handleSetValue = async (name: string) => {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/packs/${encodeURIComponent(packId)}/secrets/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'x-showrun-token': token,
        },
        body: JSON.stringify({ value: secretValue }),
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }
      setEditingSecret(null);
      setSecretValue('');
      await loadSecrets();
      onSecretsUpdated?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleCancelEdit = () => {
    setEditingSecret(null);
    setSecretValue('');
  };

  if (loading) {
    return (
      <div style={{ padding: '16px', color: 'var(--text-muted)', fontSize: '13px', textAlign: 'center' }}>
        Loading secrets...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: '16px' }}>
        <div className="error" style={{ marginBottom: '8px' }}>{error}</div>
        <button className="btn-secondary" onClick={loadSecrets} style={{ fontSize: '12px' }}>
          Retry
        </button>
      </div>
    );
  }

  if (secrets.length === 0) {
    return (
      <div style={{ padding: '16px', color: 'var(--text-muted)', fontSize: '13px', textAlign: 'center' }}>
        No secrets defined for this pack.
        <div style={{ marginTop: '8px', fontSize: '11px' }}>
          Add secrets in the pack's taskpack.json
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="network-panel-header" style={{ marginBottom: '8px' }}>
        <span>Secrets</span>
        <button
          className="btn-secondary"
          style={{ padding: '4px 12px', fontSize: '12px' }}
          onClick={loadSecrets}
        >
          Refresh
        </button>
      </div>
      <div style={{ flex: 1, overflow: 'auto' }}>
        {secrets.map((secret) => (
          <div
            key={secret.name}
            style={{
              padding: '10px 12px',
              borderBottom: '1px solid var(--border-subtle)',
              backgroundColor: editingSecret === secret.name ? 'var(--bg-card-active)' : undefined,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '4px' }}>
              <div>
                <span style={{ fontWeight: 500, color: 'var(--text-primary)', fontSize: '13px' }}>
                  {secret.name}
                </span>
                {secret.required && (
                  <span style={{ color: 'var(--accent-orange)', fontSize: '11px', marginLeft: '6px' }}>
                    (required)
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                {secret.hasValue ? (
                  <span style={{
                    fontFamily: 'monospace',
                    fontSize: '11px',
                    color: 'var(--accent-green)',
                    backgroundColor: 'rgba(34, 197, 94, 0.1)',
                    padding: '2px 6px',
                    borderRadius: '4px',
                  }}>
                    {secret.preview}
                  </span>
                ) : (
                  <span style={{
                    fontSize: '11px',
                    color: 'var(--text-muted)',
                    backgroundColor: 'rgba(100, 100, 100, 0.2)',
                    padding: '2px 6px',
                    borderRadius: '4px',
                  }}>
                    not set
                  </span>
                )}
              </div>
            </div>
            {secret.description && (
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '6px' }}>
                {secret.description}
              </div>
            )}

            {editingSecret === secret.name ? (
              <div style={{ marginTop: '8px' }}>
                <input
                  type="password"
                  placeholder="Enter secret value..."
                  value={secretValue}
                  onChange={(e) => setSecretValue(e.target.value)}
                  autoFocus
                  style={{
                    width: '100%',
                    padding: '6px 8px',
                    fontSize: '12px',
                    backgroundColor: 'var(--bg-input)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: '4px',
                    color: 'var(--text-primary)',
                    marginBottom: '6px',
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && secretValue) {
                      handleSetValue(secret.name);
                    } else if (e.key === 'Escape') {
                      handleCancelEdit();
                    }
                  }}
                />
                <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
                  <button
                    className="btn-secondary"
                    style={{ padding: '4px 10px', fontSize: '11px' }}
                    onClick={handleCancelEdit}
                    disabled={saving}
                  >
                    Cancel
                  </button>
                  <button
                    className="btn-primary"
                    style={{ padding: '4px 10px', fontSize: '11px' }}
                    onClick={() => handleSetValue(secret.name)}
                    disabled={saving || !secretValue}
                  >
                    {saving ? 'Saving...' : 'Save'}
                  </button>
                </div>
              </div>
            ) : (
              <button
                className="btn-secondary"
                style={{ padding: '3px 8px', fontSize: '11px', marginTop: '4px' }}
                onClick={() => {
                  setEditingSecret(secret.name);
                  setSecretValue('');
                }}
              >
                {secret.hasValue ? 'Update Value' : 'Set Value'}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
