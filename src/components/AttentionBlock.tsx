import { AlertCircle } from "lucide-react";

interface Props {
  message: string;
  summary?: string;
}

export function AttentionBlock({ message, summary }: Props) {
  return (
    <div className="tool-visual attention-visual">
      <div className="tool-visual-header static">
        <AlertCircle size={14} className="tool-visual-icon" />
        <span className="tool-visual-label">Attention needed</span>
      </div>
      <div className="tool-visual-body">
        <div className="attention-message">{message}</div>
        {summary && <div className="attention-summary">{summary}</div>}
      </div>
    </div>
  );
}
