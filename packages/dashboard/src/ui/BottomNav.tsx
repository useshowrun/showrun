import React from 'react';

export type NavView = 'chat' | 'runs' | 'mcp' | 'packs';

interface BottomNavProps {
  activeView: NavView;
  onViewChange: (view: NavView) => void;
  runsCount?: number;
}

export default function BottomNav({ activeView, onViewChange, runsCount = 0 }: BottomNavProps) {
  return (
    <div className="bottom-nav">
      <button
        className={`bottom-nav-item ${activeView === 'runs' ? 'active' : ''}`}
        onClick={() => onViewChange('runs')}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
        </svg>
        Runs {runsCount > 0 && `(${runsCount})`}
      </button>
      <button
        className={`bottom-nav-item ${activeView === 'mcp' ? 'active' : ''}`}
        onClick={() => onViewChange('mcp')}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
          <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
          <line x1="6" y1="6" x2="6.01" y2="6" />
          <line x1="6" y1="18" x2="6.01" y2="18" />
        </svg>
        MCP Server
      </button>
      <button
        className={`bottom-nav-item ${activeView === 'packs' ? 'active' : ''}`}
        onClick={() => onViewChange('packs')}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
          <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
          <line x1="12" y1="22.08" x2="12" y2="12" />
        </svg>
        Packs
      </button>
    </div>
  );
}
