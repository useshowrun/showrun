import React, { useState } from 'react';

interface SecretRequest {
  name: string;
  description?: string;
  required?: boolean;
}

interface SecretsRequestModalProps {
  secrets: SecretRequest[];
  message: string;
  packId: string;
  conversationId: string;
  token: string;
  onComplete: () => void;
  onCancel: () => void;
}

export default function SecretsRequestModal({
  secrets,
  message,
  packId,
  conversationId,
  token,
  onComplete,
  onCancel,
}: SecretsRequestModalProps) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const secret of secrets) {
      initial[secret.name] = '';
    }
    return initial;
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);

    try {
      // Save each secret value
      for (const secret of secrets) {
        const value = values[secret.name];
        if (value) {
          const response = await fetch(`/api/packs/${encodeURIComponent(packId)}/secrets/${encodeURIComponent(secret.name)}`, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              'x-showrun-token': token,
            },
            body: JSON.stringify({ value }),
          });
          if (!response.ok) {
            const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
            throw new Error(errorData.error || `Failed to save ${secret.name}`);
          }
        }
      }

      // Notify server that secrets have been provided
      const resumeResponse = await fetch(`/api/teach/agent/${encodeURIComponent(conversationId)}/secrets-filled`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-showrun-token': token,
        },
        body: JSON.stringify({
          secretNames: secrets.map(s => s.name),
        }),
      });

      if (!resumeResponse.ok) {
        const errorData = await resumeResponse.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(errorData.error || 'Failed to resume agent');
      }

      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleValueChange = (name: string, value: string) => {
    setValues((prev) => ({ ...prev, [name]: value }));
  };

  // Check if all required secrets have values
  const allRequiredFilled = secrets
    .filter(s => s.required !== false)
    .every(s => values[s.name]?.trim());

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
      onClick={onCancel}
    >
      <div
        className="card"
        style={{ maxWidth: '500px', width: '90%', maxHeight: '80vh', overflow: 'auto' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 style={{ marginTop: 0 }}>Secrets Required</h2>

        <div style={{
          padding: '12px 16px',
          backgroundColor: 'rgba(245, 158, 11, 0.1)',
          border: '1px solid rgba(245, 158, 11, 0.2)',
          borderRadius: '8px',
          marginBottom: '20px',
          fontSize: '14px',
          color: 'var(--text-primary)',
        }}>
          {message}
        </div>

        {error && <div className="error" style={{ marginBottom: '16px' }}>{error}</div>}

        <form onSubmit={handleSubmit}>
          {secrets.map((secret) => (
            <div key={secret.name} style={{ marginBottom: '16px' }}>
              <label>
                <strong>{secret.name}</strong>
                {secret.required !== false && (
                  <span style={{ color: 'var(--accent-orange)', marginLeft: '6px' }}>*</span>
                )}
              </label>
              {secret.description && (
                <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px', marginBottom: '6px' }}>
                  {secret.description}
                </div>
              )}
              <input
                type="password"
                value={values[secret.name]}
                onChange={(e) => handleValueChange(secret.name, e.target.value)}
                required={secret.required !== false}
                style={{
                  width: '100%',
                  padding: '8px',
                  backgroundColor: 'var(--bg-input)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: '4px',
                  color: 'var(--text-primary)',
                }}
                placeholder={`Enter ${secret.name}...`}
                autoFocus={secrets[0]?.name === secret.name}
              />
            </div>
          ))}

          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '20px' }}>
            <button
              className="btn-secondary"
              type="button"
              onClick={onCancel}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              className="btn-primary"
              type="submit"
              disabled={saving || !allRequiredFilled}
            >
              {saving ? 'Saving...' : 'Provide Secrets'}
            </button>
          </div>
        </form>

        <div style={{
          marginTop: '16px',
          fontSize: '11px',
          color: 'var(--text-muted)',
          textAlign: 'center',
        }}>
          Secret values are stored locally and never sent to the AI.
        </div>
      </div>
    </div>
  );
}
