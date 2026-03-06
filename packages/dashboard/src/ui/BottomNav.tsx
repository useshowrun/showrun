import React from 'react';
import { ShowRunIcon, ShowRunLogo } from './ShowRunLogo.js';

export type NavView = 'chat' | 'runs' | 'mcp' | 'packs';

interface NavRailProps {
  activeView: NavView;
  onViewChange: (view: NavView) => void;
  runsCount?: number;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
}

const NAV_ITEMS: { view: NavView; label: string; icon: React.ReactNode }[] = [
  {
    view: 'chat',
    label: 'Chat',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    ),
  },
  {
    view: 'runs',
    label: 'Runs',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
      </svg>
    ),
  },
  {
    view: 'mcp',
    label: 'MCP Server',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
        <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
        <line x1="6" y1="6" x2="6.01" y2="6" />
        <line x1="6" y1="18" x2="6.01" y2="18" />
      </svg>
    ),
  },
  {
    view: 'packs',
    label: 'Task Packs',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
        <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
        <line x1="12" y1="22.08" x2="12" y2="12" />
      </svg>
    ),
  },
];

export default function BottomNav({
  activeView,
  onViewChange,
  runsCount = 0,
  isExpanded = false,
  onToggleExpand,
}: NavRailProps) {
  return (
    <div
      className="nav-rail"
      style={{
        width: isExpanded ? 176 : undefined,
        alignItems: isExpanded ? 'stretch' : 'center',
        transition: 'width 0.2s ease',
      }}
    >
      {/* Logo */}
      <div
        className="nav-rail-logo"
        style={{
          width: isExpanded ? '100%' : undefined,
          justifyContent: isExpanded ? 'flex-start' : 'center',
          padding: isExpanded ? '0 14px' : undefined,
        }}
      >
        {isExpanded ? <ShowRunLogo size="sm" /> : <ShowRunIcon size={22} />}
      </div>

      <div className="nav-rail-divider" style={{ width: isExpanded ? 'calc(100% - 28px)' : undefined }} />

      {/* Nav items */}
      {NAV_ITEMS.map(({ view, label, icon }) => {
        const isActive = activeView === view;
        const showBadge = view === 'runs' && runsCount > 0;
        return (
          <button
            key={view}
            className={`nav-rail-item ${isActive ? 'active' : ''}`}
            onClick={() => onViewChange(view)}
            title={isExpanded ? undefined : label}
            style={isExpanded ? {
              width: 'calc(100% - 16px)',
              margin: '0 8px',
              justifyContent: 'flex-start',
              gap: 10,
              padding: '0 10px',
            } : undefined}
          >
            <span style={{ flexShrink: 0, position: 'relative', display: 'flex', alignItems: 'center' }}>
              {icon}
              {showBadge && !isExpanded && (
                <span className="nav-badge">{runsCount}</span>
              )}
            </span>
            {isExpanded && (
              <span style={{ fontSize: '13px', fontWeight: 500 }}>{label}</span>
            )}
            {isExpanded && showBadge && (
              <span style={{
                marginLeft: 'auto',
                minWidth: 18,
                height: 18,
                background: 'var(--accent-orange)',
                color: '#fff',
                fontSize: '10px',
                fontWeight: 700,
                borderRadius: 9,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '0 4px',
              }}>
                {runsCount}
              </span>
            )}
          </button>
        );
      })}

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Expand/collapse toggle */}
      <button
        className="nav-rail-item"
        onClick={onToggleExpand}
        title={isExpanded ? 'Collapse sidebar' : 'Expand sidebar'}
        style={isExpanded ? {
          width: 'calc(100% - 16px)',
          margin: '0 8px',
          justifyContent: 'flex-start',
          gap: 10,
          padding: '0 10px',
        } : undefined}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          {isExpanded
            ? <><polyline points="15 18 9 12 15 6" /><polyline points="9 18 3 12 9 6" /></>
            : <><polyline points="9 18 15 12 9 6" /><polyline points="15 18 21 12 15 6" /></>
          }
        </svg>
        {isExpanded && <span style={{ fontSize: '13px', fontWeight: 500 }}>Collapse</span>}
      </button>
    </div>
  );
}
