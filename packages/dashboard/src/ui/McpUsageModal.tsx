import React, { useState, useEffect } from 'react';

interface McpUsageModalProps {
  packId: string;
  packPath: string;
  onClose: () => void;
  token: string;
}

interface SystemInfo {
  nodePath: string;
  cliPath: string;
  useNpx: boolean;
}

type Section = 'claude-desktop' | 'vscode' | 'cursor';

function McpUsageModal({ packId, packPath, onClose, token }: McpUsageModalProps) {
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openSection, setOpenSection] = useState<Section | null>('claude-desktop');
  const [copied, setCopied] = useState<Section | null>(null);

  useEffect(() => {
    async function fetchSystemInfo() {
      try {
        const res = await fetch('/api/system-info', {
          headers: { 'x-showrun-token': token },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: SystemInfo = await res.json();
        setSystemInfo(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    }
    fetchSystemInfo();
  }, [token]);

  // Derive the pack directory (parent of packPath) for --packs flag
  const packDir = packPath ? packPath.replace(/\/[^/]+$/, '') : '';

  const handleCopy = async (json: string, section: Section) => {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(section);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // Fallback for non-HTTPS contexts
      const textarea = document.createElement('textarea');
      textarea.value = json;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopied(section);
      setTimeout(() => setCopied(null), 2000);
    }
  };

  const toggleSection = (section: Section) => {
    setOpenSection((prev) => (prev === section ? null : section));
  };

  const generateJson = (format: 'claude-desktop' | 'vscode' | 'cursor'): string => {
    if (!systemInfo) return '';
    const { nodePath, cliPath, useNpx } = systemInfo;

    // When launched via npx/pnpm, use "npx showrun" so the config is portable.
    // Otherwise fall back to the absolute node + cli.js path.
    const command = useNpx ? 'npx' : nodePath;
    const baseArgs = useNpx
      ? ['showrun', 'serve', '--packs', packDir]
      : [cliPath, 'serve', '--packs', packDir];

    if (format === 'vscode') {
      return JSON.stringify(
        {
          servers: {
            [packId]: {
              type: 'stdio',
              command,
              args: baseArgs,
            },
          },
        },
        null,
        2
      );
    }

    // Claude Desktop and Cursor use the same "mcpServers" format
    return JSON.stringify(
      {
        mcpServers: {
          [packId]: {
            command,
            args: baseArgs,
          },
        },
      },
      null,
      2
    );
  };

  const sections: Array<{
    key: Section;
    title: string;
    configPath: string;
    note: string;
  }> = [
    {
      key: 'claude-desktop',
      title: 'Claude Desktop',
      configPath:
        '~/Library/Application Support/Claude/claude_desktop_config.json (macOS) or %APPDATA%\\Claude\\claude_desktop_config.json (Windows)',
      note: 'Requires full app restart after config change.',
    },
    {
      key: 'vscode',
      title: 'VS Code (Copilot / Claude Code)',
      configPath: '.vscode/mcp.json in your workspace root',
      note: 'Reload the VS Code window after editing.',
    },
    {
      key: 'cursor',
      title: 'Cursor',
      configPath:
        '.cursor/mcp.json in project root, or ~/.cursor/mcp.json globally',
      note: 'Restart Cursor after config change.',
    },
  ];

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
        style={{ maxWidth: '620px', width: '90%', maxHeight: '80vh', overflow: 'auto' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <h2 style={{ margin: 0 }}>MCP Usage</h2>
          <button
            className="btn-secondary"
            onClick={onClose}
            style={{ padding: '4px 10px', fontSize: '12px' }}
          >
            Close
          </button>
        </div>

        <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '16px' }}>
          Use these configuration snippets to connect <strong>{packId}</strong> as an MCP server in your AI tool.
        </p>

        {loading && (
          <div style={{ textAlign: 'center', padding: '24px', color: 'var(--text-muted)' }}>
            <span className="spinner" style={{ marginRight: '8px' }} />
            Loading system info...
          </div>
        )}

        {error && (
          <div className="error" style={{ marginBottom: '16px' }}>
            Failed to load system info: {error}
          </div>
        )}

        {systemInfo && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {sections.map(({ key, title, configPath, note }) => {
              const isOpen = openSection === key;
              const json = generateJson(key);

              return (
                <div
                  key={key}
                  style={{
                    border: '1px solid var(--border-subtle)',
                    borderRadius: '6px',
                    overflow: 'hidden',
                  }}
                >
                  {/* Accordion header */}
                  <button
                    onClick={() => toggleSection(key)}
                    style={{
                      width: '100%',
                      padding: '10px 14px',
                      background: isOpen ? 'var(--bg-card-active)' : 'transparent',
                      border: 'none',
                      color: 'var(--text-primary)',
                      fontSize: '13px',
                      fontWeight: 600,
                      cursor: 'pointer',
                      textAlign: 'left',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <span>{title}</span>
                    <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                      {isOpen ? '\u25B2' : '\u25BC'}
                    </span>
                  </button>

                  {/* Accordion body */}
                  {isOpen && (
                    <div style={{ padding: '12px 14px', borderTop: '1px solid var(--border-subtle)' }}>
                      <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '8px' }}>
                        Config file: <code style={{ fontSize: '11px' }}>{configPath}</code>
                      </div>

                      <div style={{ position: 'relative' }}>
                        <pre
                          style={{
                            backgroundColor: 'var(--bg-main)',
                            border: '1px solid var(--border-subtle)',
                            borderRadius: '4px',
                            padding: '12px',
                            fontSize: '12px',
                            overflow: 'auto',
                            maxHeight: '200px',
                            margin: '0 0 8px 0',
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-all',
                          }}
                        >
                          {json}
                        </pre>
                        <button
                          className="btn-primary"
                          onClick={() => handleCopy(json, key)}
                          style={{
                            padding: '4px 12px',
                            fontSize: '11px',
                            position: 'absolute',
                            top: '6px',
                            right: '6px',
                          }}
                        >
                          {copied === key ? 'Copied!' : 'Copy'}
                        </button>
                      </div>

                      <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                        {note}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export default McpUsageModal;
