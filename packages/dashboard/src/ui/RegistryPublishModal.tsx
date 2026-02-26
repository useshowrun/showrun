import React, { useState, useEffect, useRef } from 'react';

interface RegistryPublishModalProps {
  packId: string;
  packName: string;
  packVersion: string;
  onClose: () => void;
}

type ModalState = 'loading' | 'login' | 'publish' | 'result';

interface DeviceInfo {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

interface PublishResult {
  slug: string;
  version: string;
  created: boolean;
  warnings: string[];
}

function RegistryPublishModal({ packId, packName, packVersion, onClose }: RegistryPublishModalProps) {
  const [state, setState] = useState<ModalState>('loading');
  const [error, setError] = useState<string | null>(null);

  // Device flow login
  const [device, setDevice] = useState<DeviceInfo | null>(null);
  const [startingLogin, setStartingLogin] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Publish form
  const [slug, setSlug] = useState(packId);
  const [visibility, setVisibility] = useState<'public' | 'private'>('public');
  const [changelog, setChangelog] = useState('');
  const [publishing, setPublishing] = useState(false);

  // Result
  const [result, setResult] = useState<PublishResult | null>(null);

  useEffect(() => {
    checkStatus();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const checkStatus = async () => {
    try {
      const res = await fetch('/api/registry/status');
      const data = await res.json();
      if (!data.configured) {
        setError('Registry not configured. Set SHOWRUN_REGISTRY_URL environment variable.');
        setState('login');
        return;
      }
      setState(data.authenticated ? 'publish' : 'login');
    } catch {
      setError('Failed to check registry status');
      setState('login');
    }
  };

  const startDeviceLogin = async () => {
    setStartingLogin(true);
    setError(null);
    try {
      const res = await fetch('/api/registry/device-login', { method: 'POST' });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to start login');
      }
      const data: DeviceInfo = await res.json();
      setDevice(data);

      // Open verification URL in new tab
      window.open(data.verificationUri, '_blank', 'noopener');

      // Start polling
      const intervalMs = Math.max(data.interval, 5) * 1000;
      pollRef.current = setInterval(() => pollForToken(data.deviceCode), intervalMs);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStartingLogin(false);
    }
  };

  const pollForToken = async (deviceCode: string) => {
    try {
      const res = await fetch('/api/registry/device-poll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceCode }),
      });
      if (!res.ok) return; // keep polling

      const data = await res.json();
      if (data.status === 'complete') {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
        setDevice(null);
        setState('publish');
      } else if (data.status === 'expired') {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
        setDevice(null);
        setError('Login code expired. Please try again.');
      }
      // 'pending' — keep polling
    } catch {
      // Network error — keep polling
    }
  };

  const handlePublish = async (e: React.FormEvent) => {
    e.preventDefault();
    setPublishing(true);
    setError(null);
    try {
      const res = await fetch(`/api/registry/publish/${packId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, visibility, changelog }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Publish failed');
      }
      const data = await res.json();
      setResult(data);
      setState('result');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPublishing(false);
    }
  };

  const handleClose = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    onClose();
  };

  const overlayStyle: React.CSSProperties = {
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
  };

  const modalStyle: React.CSSProperties = {
    width: '460px',
    maxWidth: '90vw',
  };

  const fieldStyle: React.CSSProperties = {
    marginBottom: '12px',
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '8px',
    boxSizing: 'border-box',
  };

  return (
    <div style={overlayStyle} onClick={handleClose}>
      <div className="card" style={modalStyle} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>Publish to Registry</h3>

        {error && (
          <div className="error" style={{ marginBottom: '16px' }}>
            {error}
          </div>
        )}

        {state === 'loading' && <div className="loading">Checking registry status...</div>}

        {state === 'login' && !device && (
          <div>
            <p style={{ color: 'var(--text-secondary)', marginBottom: '16px' }}>
              Log in to the ShowRun registry to publish packs.
              You'll be redirected to the registry in a new tab.
            </p>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
              <button type="button" className="btn-secondary" onClick={handleClose}>
                Cancel
              </button>
              <button
                className="btn-primary"
                onClick={startDeviceLogin}
                disabled={startingLogin}
              >
                {startingLogin ? 'Starting...' : 'Log In via Browser'}
              </button>
            </div>
          </div>
        )}

        {state === 'login' && device && (
          <div>
            <p style={{ color: 'var(--text-secondary)', marginBottom: '16px' }}>
              A new tab has been opened. Enter this code to authorize:
            </p>
            <div
              style={{
                background: 'var(--bg-secondary, #f5f5f5)',
                padding: '16px',
                borderRadius: '8px',
                textAlign: 'center',
                marginBottom: '16px',
                fontSize: '28px',
                fontFamily: 'monospace',
                fontWeight: 'bold',
                letterSpacing: '4px',
              }}
            >
              {device.userCode}
            </div>
            <p style={{ color: 'var(--text-muted)', fontSize: '13px', textAlign: 'center' }}>
              Or open: <a href={device.verificationUri} target="_blank" rel="noopener">{device.verificationUri}</a>
            </p>
            <div className="loading" style={{ marginTop: '16px' }}>
              Waiting for authorization...
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '16px' }}>
              <button type="button" className="btn-secondary" onClick={handleClose}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {state === 'publish' && (
          <form onSubmit={handlePublish}>
            <p style={{ color: 'var(--text-secondary)', marginBottom: '16px' }}>
              Publishing <strong>{packName}</strong> v{packVersion}
            </p>
            <div style={fieldStyle}>
              <label><strong>Slug:</strong></label>
              <input
                type="text"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                style={inputStyle}
                required
              />
            </div>
            <div style={fieldStyle}>
              <label><strong>Visibility:</strong></label>
              <select
                value={visibility}
                onChange={(e) => setVisibility(e.target.value as 'public' | 'private')}
                style={inputStyle}
              >
                <option value="public">Public</option>
                <option value="private">Private</option>
              </select>
            </div>
            <div style={fieldStyle}>
              <label><strong>Changelog:</strong> (optional)</label>
              <textarea
                value={changelog}
                onChange={(e) => setChangelog(e.target.value)}
                style={{ ...inputStyle, minHeight: '60px' }}
                placeholder="What changed in this version?"
              />
            </div>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
              <button type="button" className="btn-secondary" onClick={handleClose}>
                Cancel
              </button>
              <button type="submit" className="btn-primary" disabled={publishing}>
                {publishing ? 'Publishing...' : 'Publish'}
              </button>
            </div>
          </form>
        )}

        {state === 'result' && result && (
          <div>
            <div
              style={{
                background: '#d1e7dd',
                padding: '12px',
                borderRadius: '4px',
                marginBottom: '16px',
              }}
            >
              Published <strong>{result.slug}@{result.version}</strong>
              {result.created && ' (new pack created)'}
            </div>
            {result.warnings.length > 0 && (
              <div style={{ background: '#fff3cd', padding: '12px', borderRadius: '4px', marginBottom: '16px' }}>
                <strong>Warnings:</strong>
                <ul style={{ margin: '8px 0 0 0' }}>
                  {result.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn-primary" onClick={handleClose}>
                Close
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default RegistryPublishModal;
