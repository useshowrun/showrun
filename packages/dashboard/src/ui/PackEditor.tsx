import React, { useState, useEffect } from 'react';
import type { Socket } from 'socket.io-client';
import TeachMode from './TeachMode.js';
import SecretsEditor from './SecretsEditor.js';
import RegistryPublishModal from './RegistryPublishModal.js';

interface Pack {
  id: string;
  name: string;
  version: string;
  description: string;
  inputs: Record<string, any>;
  collectibles: Array<{ name: string; type: string; description?: string }>;
  path: string;
}

interface PackEditorProps {
  packId: string;
  packs: Pack[];
  socket: Socket;
  token: string;
  onBack: () => void;
  onRun: (packId: string) => void;
}

function PackEditor({ packId, packs, socket, token, onBack, onRun }: PackEditorProps) {
  const pack = packs.find((p) => p.id === packId);
  const [taskpackJson, setTaskpackJson] = useState<any>(null);
  const [flowJson, setFlowJson] = useState<any>(null);
  const [flowJsonText, setFlowJsonText] = useState('');
  const [metaForm, setMetaForm] = useState({ name: '', version: '', description: '' });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [validationResult, setValidationResult] = useState<{ ok: boolean; errors: string[]; warnings: string[] } | null>(null);
  const [showPublishModal, setShowPublishModal] = useState(false);

  useEffect(() => {
    loadPackFiles();
  }, [packId]);

  const loadPackFiles = async () => {
    setLoading(true);
    setErrors([]);
    try {
      const res = await fetch(`/api/packs/${packId}/files`);
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to load pack files');
      }
      const data = await res.json();
      setTaskpackJson(data.taskpackJson);
      setFlowJson(data.flowJson);
      setFlowJsonText(JSON.stringify(data.flowJson, null, 2));
      setMetaForm({
        name: data.taskpackJson.name || '',
        version: data.taskpackJson.version || '',
        description: data.taskpackJson.description || '',
      });
    } catch (err) {
      setErrors([err instanceof Error ? err.message : String(err)]);
    } finally {
      setLoading(false);
    }
  };

  const handleValidate = async () => {
    try {
      const parsed = JSON.parse(flowJsonText);
      const res = await fetch(`/api/packs/${packId}/validate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          flowJsonText,
          metaOverride: metaForm,
        }),
      });
      const result = await res.json();
      setValidationResult(result);
      setErrors(result.errors || []);
      setWarnings(result.warnings || []);
    } catch (err) {
      if (err instanceof SyntaxError) {
        setErrors([`Invalid JSON: ${err.message}`]);
        setValidationResult({ ok: false, errors: [`Invalid JSON: ${err.message}`], warnings: [] });
      } else {
        setErrors([err instanceof Error ? err.message : String(err)]);
      }
    }
  };

  const handleSaveFlow = async () => {
    setSaving(true);
    setErrors([]);
    try {
      const res = await fetch(`/api/packs/${packId}/flow`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-SHOWRUN-TOKEN': token,
        },
        body: JSON.stringify({ flowJsonText }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to save flow');
      }
      setLastSaved(new Date());
      await loadPackFiles(); // Reload to get updated data
    } catch (err) {
      setErrors([err instanceof Error ? err.message : String(err)]);
    } finally {
      setSaving(false);
    }
  };

  const handleSaveMeta = async () => {
    setSaving(true);
    setErrors([]);
    try {
      const res = await fetch(`/api/packs/${packId}/meta`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-SHOWRUN-TOKEN': token,
        },
        body: JSON.stringify(metaForm),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to save metadata');
      }
      setLastSaved(new Date());
      await loadPackFiles(); // Reload to get updated data
    } catch (err) {
      setErrors([err instanceof Error ? err.message : String(err)]);
    } finally {
      setSaving(false);
    }
  };

  const handleRun = async () => {
    // Validate JSON before running (empty flow is allowed)
    let parsedFlow;
    try {
      parsedFlow = JSON.parse(flowJsonText);
      if (!parsedFlow.flow || !Array.isArray(parsedFlow.flow)) {
        setErrors(['Flow must be an array. Use "flow": [] for an empty flow.']);
        return;
      }
    } catch (err) {
      setErrors(['Invalid JSON in flow editor. Please fix the JSON syntax.']);
      return;
    }

    setErrors([]);
    try {
      const res = await fetch('/api/runs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-SHOWRUN-TOKEN': token,
        },
        body: JSON.stringify({
          packId,
          inputs: {},
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to start run');
      }

      const { runId } = await res.json();
      console.log('Run started:', runId);
      
      // Call the onRun callback to switch to runs view
      onRun(packId);
    } catch (err) {
      setErrors([err instanceof Error ? err.message : String(err)]);
    }
  };

  if (!pack) {
    return <div className="error">Pack not found</div>;
  }

  if (loading) {
    return <div className="loading">Loading pack files...</div>;
  }

  const isJsonValid = (() => {
    try {
      JSON.parse(flowJsonText);
      return true;
    } catch {
      return false;
    }
  })();

  return (
    <div>
      {showPublishModal && (
        <RegistryPublishModal
          packId={pack.id}
          packName={pack.name}
          packVersion={pack.version}
          onClose={() => setShowPublishModal(false)}
        />
      )}
      <div style={{ marginBottom: '24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Task Pack</div>
          <h2 style={{ margin: 0, fontSize: '20px' }}>{pack.name}</h2>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <button className="btn-secondary" onClick={onBack}>← Back</button>
          <button className="btn-secondary" onClick={() => setShowPublishModal(true)}>Publish</button>
          <button
            className="btn-primary"
            onClick={handleRun}
            disabled={saving || loading || !isJsonValid}
            title={loading ? 'Loading...' : !isJsonValid ? 'Invalid JSON' : 'Run this pack'}
          >
            ▶ Run Pack
          </button>
        </div>
      </div>

      {errors.length > 0 && (
        <div className="error">
          <strong>Errors:</strong>
          <ul>
            {errors.map((err, i) => (
              <li key={i}>{err}</li>
            ))}
          </ul>
        </div>
      )}

      {warnings.length > 0 && (
        <div style={{ background: 'rgba(234, 179, 8, 0.1)', border: '1px solid rgba(234, 179, 8, 0.3)', color: '#eab308', padding: '12px 16px', borderRadius: '8px', marginBottom: '16px' }}>
          <strong>Warnings:</strong>
          <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
            {warnings.map((warn, i) => <li key={i}>{warn}</li>)}
          </ul>
        </div>
      )}

      {lastSaved && (
        <div style={{ background: 'rgba(34, 197, 94, 0.1)', border: '1px solid rgba(34, 197, 94, 0.2)', color: '#22c55e', padding: '8px 14px', borderRadius: '8px', marginBottom: '16px', fontSize: '13px' }}>
          ✓ Saved at {lastSaved.toLocaleTimeString()}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
        {/* Metadata Form */}
        <div className="card">
          <h3>Metadata</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div>
              <label style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-secondary)', display: 'block', marginBottom: '4px' }}>ID (read-only)</label>
              <input type="text" value={pack.id} disabled style={{ width: '100%', opacity: 0.5 }} />
            </div>
            <div>
              <label style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-secondary)', display: 'block', marginBottom: '4px' }}>Name</label>
              <input type="text" value={metaForm.name} onChange={(e) => setMetaForm({ ...metaForm, name: e.target.value })} style={{ width: '100%' }} />
            </div>
            <div>
              <label style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-secondary)', display: 'block', marginBottom: '4px' }}>Version</label>
              <input type="text" value={metaForm.version} onChange={(e) => setMetaForm({ ...metaForm, version: e.target.value })} style={{ width: '100%' }} />
            </div>
            <div>
              <label style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-secondary)', display: 'block', marginBottom: '4px' }}>Description</label>
              <textarea value={metaForm.description} onChange={(e) => setMetaForm({ ...metaForm, description: e.target.value })} style={{ width: '100%', minHeight: '80px' }} />
            </div>
            <button className="btn-primary" onClick={handleSaveMeta} disabled={saving} style={{ alignSelf: 'flex-start' }}>
              {saving ? 'Saving...' : 'Save Metadata'}
            </button>
          </div>
        </div>

        {/* Flow Editor */}
        <div className="card">
          <h3>Flow JSON</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <textarea
              value={flowJsonText}
              onChange={(e) => { setFlowJsonText(e.target.value); setErrors([]); setValidationResult(null); }}
              style={{
                width: '100%',
                minHeight: '380px',
                fontFamily: 'var(--font-mono)',
                fontSize: '12px',
                lineHeight: 1.6,
                border: isJsonValid ? '1px solid var(--border-subtle)' : '1px solid var(--status-error)',
                resize: 'vertical',
              }}
              placeholder='{"inputs": {}, "collectibles": [], "flow": []}'
            />
            <div style={{ display: 'flex', gap: '8px' }}>
              <button className="btn-secondary" onClick={handleValidate} disabled={!isJsonValid}>Validate</button>
              <button className="btn-primary" onClick={handleSaveFlow} disabled={!isJsonValid || saving}>{saving ? 'Saving...' : 'Save Flow'}</button>
              <button className="btn-secondary" onClick={loadPackFiles} disabled={saving}>Revert</button>
            </div>
            {validationResult && (
              <div style={{
                padding: '8px 12px',
                borderRadius: '6px',
                fontSize: '13px',
                background: validationResult.ok ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
                border: `1px solid ${validationResult.ok ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`,
                color: validationResult.ok ? '#22c55e' : '#f87171',
              }}>
                {validationResult.ok ? '✓ Validation passed' : '✗ Validation failed'}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Secrets Management */}
      <div className="card" style={{ marginTop: '24px' }}>
        <h3>Secrets</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '12px' }}>
          Manage credentials and API keys securely. Values are stored locally and never exposed to AI.
        </p>
        <SecretsEditor packId={packId} token={token} />
      </div>

      {/* Teach Mode */}
      <div className="card" style={{ marginTop: '24px' }}>
        <h3>Teach Mode</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '12px' }}>
          Use the browser and chat to build the flow. When the agent applies a step, the Flow JSON above updates in real time.
        </p>
        <TeachMode
          token={token}
          packs={[pack]}
          packId={packId}
          onFlowUpdated={(flow) => {
            setFlowJson(flow);
            setFlowJsonText(JSON.stringify(flow, null, 2));
          }}
        />
      </div>
    </div>
  );
}

export default PackEditor;
