import React, { useState, useEffect, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';
import Sidebar, { type Conversation } from './Sidebar.js';
import ChatView from './ChatView.js';
import BottomNav, { type NavView } from './BottomNav.js';
import RunsView from './RunsView.js';
import MCPServerView from './MCPServerView.js';
import PacksView from './PacksView.js';

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

interface Run {
  runId: string;
  packId: string;
  packName: string;
  status: 'queued' | 'running' | 'success' | 'failed';
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  runDir?: string;
  eventsPath?: string;
  artifactsDir?: string;
  collectibles?: Record<string, unknown>;
  meta?: {
    url?: string;
    durationMs: number;
    notes?: string;
  };
  error?: string;
  conversationId?: string;
  source?: 'dashboard' | 'mcp' | 'cli' | 'agent';
}

interface Config {
  token: string;
  packsCount: number;
}

function App() {
  const [config, setConfig] = useState<Config | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [packs, setPacks] = useState<Pack[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<NavView>('chat');
  const [navExpanded, setNavExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Fetch config and initialize
  useEffect(() => {
    async function init() {
      try {
        const configRes = await fetch('/api/config');
        if (!configRes.ok) {
          throw new Error('Failed to fetch config');
        }
        const configData = (await configRes.json()) as Config;
        setConfig(configData);

        // Initialize socket with token
        const newSocket = io({
          auth: {
            token: configData.token,
          },
        });

        newSocket.on('connect', () => {
          console.log('Socket connected');
        });

        newSocket.on('disconnect', () => {
          console.log('Socket disconnected');
        });

        newSocket.on('runs:list', (runsList: Run[]) => {
          setRuns(runsList);
        });

        newSocket.on('conversations:updated', (convList: Conversation[]) => {
          setConversations(convList);
        });

        newSocket.on('packs:updated', () => {
          fetch('/api/packs')
            .then((res) => res.json())
            .then((data) => setPacks(data as Pack[]))
            .catch(console.error);
        });

        setSocket(newSocket);

        // Fetch initial data in parallel
        const [packsRes, runsRes, convsRes] = await Promise.all([
          fetch('/api/packs'),
          fetch('/api/runs'),
          fetch('/api/conversations'),
        ]);

        if (packsRes.ok) {
          const packsData: Pack[] = await packsRes.json();
          setPacks(packsData);
        }

        if (runsRes.ok) {
          const runsData = (await runsRes.json()) as Run[];
          setRuns(runsData);
        }

        if (convsRes.ok) {
          const convsData = (await convsRes.json()) as Conversation[];
          setConversations(convsData);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    }

    init();

    return () => {
      if (socket) {
        socket.disconnect();
      }
    };
  }, []);

  const handleNewChat = async () => {
    if (!config) return;

    try {
      const res = await fetch('/api/conversations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-showrun-token': config.token,
        },
        body: JSON.stringify({
          title: 'New Conversation',
        }),
      });

      if (res.ok) {
        const newConv = (await res.json()) as Conversation;
        setConversations((prev) => {
          // Avoid duplicates if socket event already added it
          if (prev.some((c) => c.id === newConv.id)) {
            return prev;
          }
          return [newConv, ...prev];
        });
        setSelectedConversationId(newConv.id);
        setActiveView('chat');
      }
    } catch (err) {
      console.error('Failed to create conversation:', err);
    }
  };

  const handleEditTitle = async (id: string, title: string) => {
    if (!config) return;

    try {
      const res = await fetch(`/api/conversations/${id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'x-showrun-token': config.token,
        },
        body: JSON.stringify({ title }),
      });

      if (res.ok) {
        const updated = (await res.json()) as Conversation;
        setConversations((prev) =>
          prev.map((c) => (c.id === id ? updated : c))
        );
      }
    } catch (err) {
      console.error('Failed to update title:', err);
    }
  };

  const handleDeleteConversation = async (id: string) => {
    if (!config) return;

    try {
      const res = await fetch(`/api/conversations/${id}`, {
        method: 'DELETE',
        headers: {
          'x-showrun-token': config.token,
        },
      });

      if (res.ok) {
        setConversations((prev) => prev.filter((c) => c.id !== id));
        if (selectedConversationId === id) {
          setSelectedConversationId(null);
        }
      }
    } catch (err) {
      console.error('Failed to delete conversation:', err);
    }
  };

  const handleNewChatWithPack = async (packId: string) => {
    if (!config) return;

    try {
      const res = await fetch('/api/conversations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-showrun-token': config.token,
        },
        body: JSON.stringify({ title: 'New Conversation', packId }),
      });

      if (res.ok) {
        const newConv = (await res.json()) as Conversation;
        setConversations((prev) => {
          if (prev.some((c) => c.id === newConv.id)) return prev;
          return [newConv, ...prev];
        });
        setSelectedConversationId(newConv.id);
        setActiveView('chat');
      }
    } catch (err) {
      console.error('Failed to create conversation with pack:', err);
    }
  };

  // Resizable sidebar
  const [sidebarWidth, setSidebarWidth] = useState(280);
  const sidebarIsResizing = useRef(false);
  const sidebarStartX = useRef(0);
  const sidebarStartWidth = useRef(0);

  const handleSidebarResizeStart = (e: React.MouseEvent) => {
    sidebarIsResizing.current = true;
    sidebarStartX.current = e.clientX;
    sidebarStartWidth.current = sidebarWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!sidebarIsResizing.current) return;
      const delta = e.clientX - sidebarStartX.current;
      const newWidth = Math.min(480, Math.max(180, sidebarStartWidth.current + delta));
      setSidebarWidth(newWidth);
    };
    const onMouseUp = () => {
      if (sidebarIsResizing.current) {
        sidebarIsResizing.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  if (error) {
    return (
      <div className="app-container" style={{ justifyContent: 'center', alignItems: 'center' }}>
        <div className="error" style={{ maxWidth: '400px', textAlign: 'center' }}>
          <h2 style={{ marginBottom: '8px' }}>Connection Error</h2>
          <p>{error}</p>
        </div>
      </div>
    );
  }

  if (loading || !config || !socket) {
    return (
      <div className="app-container" style={{ justifyContent: 'center', alignItems: 'center' }}>
        <div className="loading">
          <span className="spinner" style={{ width: '24px', height: '24px', marginBottom: '16px' }} />
          <div>Loading...</div>
        </div>
      </div>
    );
  }

  // Render based on active view
  const renderMainContent = () => {
    switch (activeView) {
      case 'chat':
        return (
          <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
            {conversations.map((conversation) => (
              <div
                key={conversation.id}
                style={{
                  display: selectedConversationId === conversation.id ? 'flex' : 'none',
                  width: '100%',
                  height: '100%',
                }}
              >
                <ChatView
                  conversation={conversation}
                  token={config.token}
                  onCreateConversationWithPack={handleNewChatWithPack}
                />
              </div>
            ))}
            {!selectedConversationId && (
              <ChatView
                conversation={null}
                token={config.token}
                onCreateConversationWithPack={handleNewChatWithPack}
              />
            )}
          </div>
        );
      case 'runs':
        return (
          <div style={{ flex: 1, overflow: 'hidden', display: 'flex' }}>
            <RunsView runs={runs} socket={socket} />
          </div>
        );
      case 'mcp':
        return (
          <div style={{ flex: 1, overflow: 'auto', padding: '24px' }}>
            <MCPServerView
              packs={packs}
              token={config.token}
              conversations={conversations.filter(c => c.status === 'ready')}
            />
          </div>
        );
      case 'packs':
        return (
          <div style={{ flex: 1, overflow: 'auto', padding: '24px' }}>
            <PacksView
              packs={packs}
              conversations={conversations}
              socket={socket}
              token={config.token}
              onRun={() => setActiveView('runs')}
              onEditInChat={handleNewChatWithPack}
            />
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div className="app-container">
      {/* Left icon navigation rail — always visible */}
      <BottomNav
        activeView={activeView}
        onViewChange={setActiveView}
        runsCount={runs.filter((r) => r.status === 'running').length}
        isExpanded={navExpanded}
        onToggleExpand={() => setNavExpanded((v) => !v)}
      />

      {/* Conversations sidebar — only in chat view, resizable */}
      {activeView === 'chat' && (
        <>
          <div className="sidebar" style={{ width: sidebarWidth }}>
            <Sidebar
              conversations={conversations}
              selectedId={selectedConversationId}
              onSelect={(id) => setSelectedConversationId(id)}
              onNewChat={handleNewChat}
              onEditTitle={handleEditTitle}
              onDelete={handleDeleteConversation}
            />
          </div>
          <div
            className="resize-handle"
            onMouseDown={handleSidebarResizeStart}
            title=""
          />
        </>
      )}

      {/* Main content area */}
      <div className="main-content">
        {renderMainContent()}
      </div>
    </div>
  );
}

export default App;
