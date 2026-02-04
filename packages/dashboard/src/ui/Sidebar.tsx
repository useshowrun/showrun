import React from 'react';

export interface Conversation {
  id: string;
  title: string;
  description: string | null;
  status: 'active' | 'ready' | 'needs_input' | 'error';
  packId: string | null;
  createdAt: number;
  updatedAt: number;
}

interface SidebarProps {
  conversations: Conversation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onEditTitle?: (id: string, title: string) => void;
}

function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

function getStatusLabel(status: Conversation['status']): string {
  switch (status) {
    case 'active':
      return 'Active';
    case 'ready':
      return 'Ready';
    case 'needs_input':
      return 'Needs Input';
    case 'error':
      return 'Error';
    default:
      return status;
  }
}

export default function Sidebar({
  conversations,
  selectedId,
  onSelect,
  onNewChat,
  onEditTitle,
}: SidebarProps) {
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editValue, setEditValue] = React.useState('');
  const inputRef = React.useRef<HTMLInputElement>(null);

  const startEditing = (conv: Conversation, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(conv.id);
    setEditValue(conv.title);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const saveEdit = () => {
    if (editingId && editValue.trim() && onEditTitle) {
      onEditTitle(editingId, editValue.trim());
    }
    setEditingId(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditValue('');
  };

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-title">Conversations</div>
      </div>

      <div className="conversation-list">
        {conversations.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-description">
              No conversations yet. Start a new chat to begin.
            </div>
          </div>
        ) : (
          conversations.map((conv) => (
            <div
              key={conv.id}
              className={`conversation-item ${selectedId === conv.id ? 'active' : ''}`}
              onClick={() => onSelect(conv.id)}
            >
              {editingId === conv.id ? (
                <input
                  ref={inputRef}
                  type="text"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onBlur={saveEdit}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveEdit();
                    if (e.key === 'Escape') cancelEdit();
                  }}
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    width: '100%',
                    padding: '4px 8px',
                    fontSize: '14px',
                    border: '1px solid var(--accent-orange)',
                    borderRadius: '4px',
                    background: 'var(--bg-input)',
                    color: 'var(--text-primary)',
                  }}
                />
              ) : (
                <div
                  className="conversation-title"
                  onDoubleClick={(e) => startEditing(conv, e)}
                  title="Double-click to edit"
                >
                  {conv.title}
                </div>
              )}
              {conv.description && (
                <div className="conversation-description">{conv.description}</div>
              )}
              <div className="conversation-meta">
                <span className={`status-dot ${conv.status}`} />
                <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  {getStatusLabel(conv.status)}
                </span>
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  {formatRelativeTime(conv.updatedAt)}
                </span>
              </div>
            </div>
          ))
        )}
      </div>

      <button className="new-chat-btn" onClick={onNewChat}>
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        New Chat
      </button>
    </div>
  );
}
