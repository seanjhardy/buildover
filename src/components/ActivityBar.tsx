import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MessageSquare, GitBranch, GitPullRequest, FolderOpen } from "lucide-react";

export type WorkspaceView = 'chat' | 'source-control' | 'pr' | 'files';

interface Props {
  activeView: WorkspaceView;
  onViewChange: (view: WorkspaceView) => void;
  scBadge?: number;
  prBadge?: number;
}

interface NavItem {
  id: WorkspaceView;
  icon: React.ReactNode;
  label: string;
  badge?: number;
}

function ActivityBarItem({
  item,
  active,
  onClick,
}: {
  item: NavItem;
  active: boolean;
  onClick: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [tooltipTop, setTooltipTop] = useState<number | null>(null);

  return (
    <button
      ref={ref}
      className={`activity-bar-item${active ? ' active' : ''}`}
      onClick={onClick}
      onMouseEnter={() => {
        if (ref.current) {
          const rect = ref.current.getBoundingClientRect();
          setTooltipTop(rect.top + rect.height / 2);
        }
      }}
      onMouseLeave={() => setTooltipTop(null)}
      aria-label={item.label}
    >
      {item.icon}
      {(item.badge ?? 0) > 0 && (
        <span className="activity-bar-badge">
          {item.badge! > 99 ? '99+' : item.badge}
        </span>
      )}
      {tooltipTop !== null &&
        createPortal(
          <div
            className="activity-bar-tooltip"
            style={{ top: tooltipTop, left: 52 }}
          >
            {item.label}
          </div>,
          document.body,
        )}
    </button>
  );
}

export function ActivityBar({ activeView, onViewChange, scBadge, prBadge }: Props) {
  const items: NavItem[] = [
    { id: 'chat', icon: <MessageSquare size={20} />, label: 'Chats' },
    { id: 'files', icon: <FolderOpen size={20} />, label: 'Explorer' },
    {
      id: 'source-control',
      icon: <GitBranch size={20} />,
      label: 'Source Control',
      badge: scBadge,
    },
    {
      id: 'pr',
      icon: <GitPullRequest size={20} />,
      label: 'Pull Requests',
      badge: prBadge,
    },
  ];

  return (
    <nav className="activity-bar" aria-label="Activity">
      {items.map((item) => (
        <ActivityBarItem
          key={item.id}
          item={item}
          active={activeView === item.id}
          onClick={() => onViewChange(item.id)}
        />
      ))}
    </nav>
  );
}
