import { useRef } from "react";
import { X, RotateCw, ArrowLeft } from "lucide-react";

interface PreviewPaneProps {
  url: string;
  onClose: () => void;
}

export function PreviewPane({ url, onClose }: PreviewPaneProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const reload = () => {
    if (iframeRef.current) {
      // eslint-disable-next-line no-self-assign
      iframeRef.current.src = iframeRef.current.src;
    }
  };

  return (
    <div className="preview-pane">
      <div className="preview-pane-toolbar">
        <button type="button" className="preview-pane-btn" onClick={onClose} title="Close preview">
          <ArrowLeft size={13} />
        </button>
        <span className="preview-pane-url">{url}</span>
        <button type="button" className="preview-pane-btn" onClick={reload} title="Reload">
          <RotateCw size={13} />
        </button>
        <button type="button" className="preview-pane-btn" onClick={onClose} title="Exit preview">
          <X size={13} />
        </button>
      </div>
      <iframe
        ref={iframeRef}
        className="preview-pane-frame"
        src={url}
        title="App preview"
      />
    </div>
  );
}
