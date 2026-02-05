import React, { useState, useEffect } from 'react';
import type { Socket } from 'socket.io-client';
import TeachMode from './TeachMode.js';
import SecretsEditor from './SecretsEditor.js';

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
      <div style={{ marginBottom: '20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>Edit Pack: {pack.name}</h2>
        <div>
          <button onClick={onBack} style={{ marginRight: '10px' }}>Back to Packs</button>
          <button 
            onClick={handleRun} 
            disabled={saving || loading || !isJsonValid}
            title={
              loading 
                ? 'Loading pack files...' 
                : !isJsonValid 
                ? 'Invalid JSON in flow editor' 
                : 'Run this pack'
            }
          >
            Run Pack
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
        <div style={{ background: '#fff3cd', padding: '12px', borderRadius: '4px', marginBottom: '20px' }}>
          <strong>Warnings:</strong>
          <ul>
            {warnings.map((warn, i) => (
              <li key={i}>{warn}</li>
            ))}
          </ul>
        </div>
      )}

      {lastSaved && (
        <div style={{ background: '#d1e7dd', padding: '8px', borderRadius: '4px', marginBottom: '20px' }}>
          Last saved: {lastSaved.toLocaleTimeString()}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
        {/* Metadata Form */}
        <div className="card">
          <h3>Metadata</h3>
          <div style={{ marginBottom: '12px' }}>
            <label>
              <strong>ID:</strong> (read-only)
            </label>
            <input type="text" value={pack.id} disabled style={{ width: '100%', padding: '8px' }} />
          </div>
          <div style={{ marginBottom: '12px' }}>
            <label>
              <strong>Name:</strong>
            </label>
            <input
              type="text"
              value={metaForm.name}
              onChange={(e) => setMetaForm({ ...metaForm, name: e.target.value })}
              style={{ width: '100%', padding: '8px' }}
            />
          </div>
          <div style={{ marginBottom: '12px' }}>
            <label>
              <strong>Version:</strong>
            </label>
            <input
              type="text"
              value={metaForm.version}
              onChange={(e) => setMetaForm({ ...metaForm, version: e.target.value })}
              style={{ width: '100%', padding: '8px' }}
            />
          </div>
          <div style={{ marginBottom: '12px' }}>
            <label>
              <strong>Description:</strong>
            </label>
            <textarea
              value={metaForm.description}
              onChange={(e) => setMetaForm({ ...metaForm, description: e.target.value })}
              style={{ width: '100%', padding: '8px', minHeight: '80px' }}
            />
          </div>
          <button onClick={handleSaveMeta} disabled={saving}>
            {saving ? 'Saving...' : 'Save Metadata'}
          </button>
        </div>

        {/* Flow Editor */}
        <div className="card">
          <h3>Flow JSON</h3>
          <div style={{ marginBottom: '12px' }}>
            <textarea
              value={flowJsonText}
              onChange={(e) => {
                setFlowJsonText(e.target.value);
                setErrors([]);
                setValidationResult(null);
              }}
              style={{
                width: '100%',
                minHeight: '400px',
                fontFamily: 'monospace',
                fontSize: '12px',
                padding: '8px',
                border: isJsonValid ? '1px solid #ddd' : '1px solid #dc3545',
              }}
              placeholder='{"inputs": {}, "collectibles": [], "flow": []}'
            />
          </div>
          <div style={{ display: 'flex', gap: '10px' }}>
            <button onClick={handleValidate} disabled={!isJsonValid}>
              Validate
            </button>
            <button onClick={handleSaveFlow} disabled={!isJsonValid || saving}>
              {saving ? 'Saving...' : 'Save Flow'}
            </button>
            <button onClick={loadPackFiles} disabled={saving}>
              Revert
            </button>
          </div>
          {validationResult && (
            <div style={{ marginTop: '12px', padding: '8px', background: validationResult.ok ? '#d1e7dd' : '#f8d7da', borderRadius: '4px' }}>
              {validationResult.ok ? '✓ Validation passed' : '✗ Validation failed'}
            </div>
          )}
        </div>
      </div>

      {/* Secrets Management */}
      <div className="card" style={{ marginTop: '24px' }}>
        <h3>Secrets</h3>
        <p style={{ color: '#666', fontSize: '14px', marginBottom: '12px' }}>
          Manage credentials and API keys securely. Values are stored locally and never exposed to AI.
        </p>
        <SecretsEditor packId={packId} token={token} />
      </div>

      {/* Teach Mode: AI + browser; flow updates reflected in editor above in real time */}
      <div className="card" style={{ marginTop: '24px' }}>
        <h3>Teach Mode</h3>
        <p style={{ color: '#666', fontSize: '14px', marginBottom: '12px' }}>
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
