import React, { useState, useEffect } from 'react';
import { io, type Socket } from 'socket.io-client';
import Sidebar, { type Conversation } from './Sidebar.js';
import ChatView, { type Message } from './ChatView.js';
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

interface ConversationWithMessages extends Conversation {
  messages?: Message[];
}

function App() {
  const [config, setConfig] = useState<Config | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [packs, setPacks] = useState<Pack[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [selectedConversation, setSelectedConversation] = useState<ConversationWithMessages | null>(null);
  const [activeView, setActiveView] = useState<NavView>('chat');
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

  // Load full conversation when selection changes
  useEffect(() => {
    if (!selectedConversationId || !config) {
      setSelectedConversation(null);
      return;
    }

    async function loadConversation() {
      try {
        const res = await fetch(`/api/conversations/${selectedConversationId}`);
        if (res.ok) {
          const data = await res.json();
          setSelectedConversation(data);
        }
      } catch (err) {
        console.error('Failed to load conversation:', err);
      }
    }

    loadConversation();
  }, [selectedConversationId, config]);

  // Sync selectedConversation with conversations list when it updates
  // This ensures changes from socket updates (e.g., packId linked) are reflected
  useEffect(() => {
    if (!selectedConversationId || !selectedConversation) return;

    const updated = conversations.find((c) => c.id === selectedConversationId);
    if (updated) {
      // Merge list updates into selectedConversation, preserving messages
      const hasChanges =
        updated.title !== selectedConversation.title ||
        updated.description !== selectedConversation.description ||
        updated.status !== selectedConversation.status ||
        updated.packId !== selectedConversation.packId;

      if (hasChanges) {
        setSelectedConversation((prev) =>
          prev
            ? {
                ...prev,
                title: updated.title,
                description: updated.description,
                status: updated.status,
                packId: updated.packId,
                updatedAt: updated.updatedAt,
              }
            : null
        );
      }
    }
  }, [conversations, selectedConversationId]);

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
        if (selectedConversation?.id === id) {
          setSelectedConversation((prev) => (prev ? { ...prev, title } : null));
        }
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
          setSelectedConversation(null);
        }
      }
    } catch (err) {
      console.error('Failed to delete conversation:', err);
    }
  };

  const handleConversationUpdate = (updates: Partial<Conversation>) => {
    if (!selectedConversation) return;
    setSelectedConversation((prev) => (prev ? { ...prev, ...updates } : null));
    setConversations((prev) =>
      prev.map((c) => (c.id === selectedConversation.id ? { ...c, ...updates } : c))
    );
  };

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
          <ChatView
            conversation={selectedConversation}
            token={config.token}
            packs={packs}
            onConversationUpdate={handleConversationUpdate}
          />
        );
      case 'runs':
        return (
          <div style={{ flex: 1, overflow: 'auto', padding: '24px' }}>
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
              socket={socket}
              token={config.token}
              onRun={() => setActiveView('runs')}
            />
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div className="app-container">
      {/* Sidebar - only show in chat view */}
      {activeView === 'chat' && (
        <Sidebar
          conversations={conversations}
          selectedId={selectedConversationId}
          onSelect={(id) => setSelectedConversationId(id)}
          onNewChat={handleNewChat}
          onEditTitle={handleEditTitle}
          onDelete={handleDeleteConversation}
        />
      )}

      {/* Main content area */}
      <div className="main-content">
        {/* Header */}
        <div className="header">
          {activeView !== 'chat' && (
            <button
              className="header-back"
              onClick={() => setActiveView('chat')}
              title="Back to Chat"
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>
          )}
          <div className="header-logo">ShowRun</div>
        </div>

        {/* Main content */}
        {renderMainContent()}

        {/* Bottom navigation */}
        <BottomNav
          activeView={activeView}
          onViewChange={setActiveView}
          runsCount={runs.filter((r) => r.status === 'running').length}
        />
      </div>
    </div>
  );
}

export default App;
