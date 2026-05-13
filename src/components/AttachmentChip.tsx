import type { Attachment } from "../types.js";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

interface Props {
  attachment: Attachment;
  onRemove?: () => void;
  onClick?: () => void;
  compact?: boolean;
}

export function AttachmentChip({ attachment, onRemove, onClick, compact }: Props) {
  const isImage = attachment.mime.startsWith("image/");
  const classes = [
    "attachment",
    compact ? "compact" : "",
    onClick ? "attachment--clickable" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={classes}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } } : undefined}
    >
      {isImage && attachment.dataUrl ? (
        <img className="attachment-thumb" src={attachment.dataUrl} alt="" />
      ) : (
        <span className="attachment-icon">▣</span>
      )}
      <div className="attachment-meta">
        <div className="attachment-name" title={attachment.name}>
          {attachment.name}
        </div>
        <div className="attachment-sub">
          {attachment.mime} · {formatBytes(attachment.size)}
        </div>
      </div>
      {onRemove && (
        <button
          className="attachment-remove"
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          aria-label="Remove"
        >
          ×
        </button>
      )}
    </div>
  );
}
