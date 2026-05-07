import type { Attachment } from "../types.js";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

interface Props {
  attachment: Attachment;
  onRemove?: () => void;
  compact?: boolean;
}

export function AttachmentChip({ attachment, onRemove, compact }: Props) {
  const isImage = attachment.mime.startsWith("image/");
  return (
    <div className={`attachment ${compact ? "compact" : ""}`}>
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
          onClick={onRemove}
          aria-label="Remove"
        >
          ×
        </button>
      )}
    </div>
  );
}
