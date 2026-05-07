import { useEffect, useRef, useState } from "react";
import {
  type Attachment,
  type Model,
  type PermissionMode,
} from "../types.js";
import { AttachmentChip } from "./AttachmentChip.js";
import { useTranscription } from "../hooks/useTranscription.js";

interface Props {
  onSend: (text: string, attachments: Attachment[]) => void;
  onInterrupt: () => void;
  disabled: boolean;
  isStreaming: boolean;
  model: Model;
  permissionMode: PermissionMode;
  onPermissionModeChange: (m: PermissionMode) => void;
  onToggleMcp: () => void;
}

const MAX_TEXT_BYTES = 256 * 1024;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const SUPPORTED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];

const MODE_CYCLE: PermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
];

const MODE_META: Record<
  PermissionMode,
  { label: string; description: string; icon: string }
> = {
  default: {
    label: "Ask before edits",
    description: "Claude will ask for approval before making each edit",
    icon: "✋",
  },
  acceptEdits: {
    label: "Edit automatically",
    description: "Claude will edit your selected text or the whole file",
    icon: "</>",
  },
  plan: {
    label: "Plan mode",
    description:
      "Claude will explore the code and present a plan before editing",
    icon: "▤",
  },
  bypassPermissions: {
    label: "Bypass permissions",
    description:
      "Claude will not ask for approval before running potentially dangerous commands",
    icon: "⊕",
  },
};

async function fileToAttachment(file: File): Promise<Attachment> {
  const isImage = file.type.startsWith("image/");
  const id = `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (isImage) {
    if (!SUPPORTED_IMAGE_TYPES.includes(file.type)) {
      throw new Error(
        `Unsupported image type: ${file.type}. Supported: PNG, JPG, GIF, WebP.`,
      );
    }
    if (file.size > MAX_IMAGE_BYTES) {
      throw new Error(`Image too large (max ${MAX_IMAGE_BYTES / 1024 / 1024}MB)`);
    }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    return { id, name: file.name, mime: file.type, size: file.size, dataUrl };
  }
  if (file.size > MAX_TEXT_BYTES) {
    throw new Error(`Text file too large (max ${MAX_TEXT_BYTES / 1024}KB)`);
  }
  const contents = await file.text();
  return {
    id,
    name: file.name,
    mime: file.type || "text/plain",
    size: file.size,
    contents,
  };
}

export function Composer(props: Props) {
  const {
    onSend,
    onInterrupt,
    disabled,
    isStreaming,
    permissionMode,
    onPermissionModeChange,
    onToggleMcp,
  } = props;

  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modePopupOpen, setModePopupOpen] = useState(false);
  const [plusPopupOpen, setPlusPopupOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const modeWrapRef = useRef<HTMLDivElement>(null);
  const plusWrapRef = useRef<HTMLDivElement>(null);
  // Snapshot of composer text at the moment recording started; transcripts
  // are appended to this prefix so partial updates can replace cleanly.
  const transcriptPrefixRef = useRef<string>("");

  const transcription = useTranscription({
    onTranscript: (transcript) => {
      const prefix = transcriptPrefixRef.current;
      const sep = prefix && transcript && !/\s$/.test(prefix) ? " " : "";
      setText(prefix + sep + transcript);
    },
  });

  const toggleMic = async () => {
    if (transcription.state === "recording") {
      await transcription.stop();
      transcriptPrefixRef.current = "";
      return;
    }
    if (transcription.state === "transcribing") return;
    setError(null);
    transcriptPrefixRef.current = text;
    await transcription.start();
  };

  // Close popups on outside click.
  useEffect(() => {
    if (!modePopupOpen && !plusPopupOpen) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      if (modePopupOpen && !modeWrapRef.current?.contains(target)) {
        setModePopupOpen(false);
      }
      if (plusPopupOpen && !plusWrapRef.current?.contains(target)) {
        setPlusPopupOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [modePopupOpen, plusPopupOpen]);

  const cycleMode = () => {
    const idx = MODE_CYCLE.indexOf(permissionMode);
    const next = MODE_CYCLE[(idx + 1) % MODE_CYCLE.length];
    onPermissionModeChange(next);
  };

  const submit = () => {
    const trimmed = text.trim();
    if ((!trimmed && attachments.length === 0) || disabled) return;
    onSend(trimmed, attachments);
    setText("");
    setAttachments([]);
  };

  const addFiles = async (files: FileList | File[]) => {
    setError(null);
    const next: Attachment[] = [];
    for (const f of Array.from(files)) {
      try {
        next.push(await fileToAttachment(f));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
    if (next.length) setAttachments((a) => [...a, ...next]);
  };

  const meta = MODE_META[permissionMode];

  return (
    <div
      ref={containerRef}
      className={`composer ${dragOver ? "drag-over" : ""}`}
      data-permission-mode={permissionMode}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
      }}
    >
      {attachments.length > 0 && (
        <div className="composer-attachments">
          {attachments.map((a) => (
            <AttachmentChip
              key={a.id}
              attachment={a}
              onRemove={() =>
                setAttachments((list) => list.filter((x) => x.id !== a.id))
              }
            />
          ))}
        </div>
      )}
      {error && <div className="composer-error">{error}</div>}

      <textarea
        className="composer-input"
        placeholder={
          disabled
            ? "Claude is working…"
            : permissionMode === "plan"
              ? "Describe what you want Claude to plan…"
              : "Message Claude (Shift+Tab cycles modes)"
        }
        value={text}
        onChange={(e) => setText(e.target.value)}
        onPaste={async (e) => {
          const items = e.clipboardData?.items;
          if (!items) return;
          const files: File[] = [];
          for (const item of items) {
            if (item.kind === "file") {
              const f = item.getAsFile();
              if (f) files.push(f);
            }
          }
          if (files.length) {
            e.preventDefault();
            addFiles(files);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Tab" && e.shiftKey) {
            e.preventDefault();
            cycleMode();
            return;
          }
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        rows={2}
      />

      <div className="composer-bar">
        <div className="composer-bar-left">
          <div ref={plusWrapRef} className="popup-wrap">
            <button
              className="round-btn"
              onClick={() => setPlusPopupOpen((v) => !v)}
              title="Add context"
              disabled={disabled}
            >
              +
            </button>
            {plusPopupOpen && (
              <div className="plus-popup" role="menu">
                <button
                  className="popup-item"
                  onClick={() => {
                    setPlusPopupOpen(false);
                    fileInputRef.current?.click();
                  }}
                >
                  <span className="popup-item-icon">↥</span>
                  <div>
                    <div className="popup-item-label">Add context</div>
                    <div className="popup-item-desc">
                      Attach files, images, or PDFs
                    </div>
                  </div>
                </button>
                <button
                  className="popup-item"
                  onClick={() => {
                    setPlusPopupOpen(false);
                    onToggleMcp();
                  }}
                >
                  <span className="popup-item-icon">⚙</span>
                  <div>
                    <div className="popup-item-label">View tools</div>
                    <div className="popup-item-desc">
                      Built-in tools and MCP servers
                    </div>
                  </div>
                </button>
              </div>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>

        <div className="composer-bar-right">
          <button
            className={`mic-btn ${transcription.state}`}
            onClick={toggleMic}
            disabled={
              disabled || transcription.state === "transcribing"
            }
            title={
              transcription.state === "recording"
                ? "Stop recording"
                : transcription.state === "transcribing"
                  ? "Transcribing…"
                  : transcription.error
                    ? `Mic error: ${transcription.error}`
                    : "Record voice (Whisper)"
            }
            aria-label={
              transcription.state === "recording"
                ? "Stop recording"
                : "Start voice input"
            }
          >
            {transcription.state === "recording" ? (
              <span className="mic-rec-dot" />
            ) : transcription.state === "transcribing" ? (
              <span className="mic-spinner" />
            ) : (
              <span className="mic-icon" aria-hidden="true">🎤</span>
            )}
          </button>
          <div ref={modeWrapRef} className="popup-wrap">
            <button
              className="mode-pill"
              onClick={() => setModePopupOpen((v) => !v)}
              title="Mode (Shift+Tab to cycle)"
            >
              <span className="mode-pill-icon">{meta.icon}</span>
              {meta.label}
            </button>
            {modePopupOpen && (
              <div className="mode-popup" role="dialog">
                <div className="mode-popup-head">
                  <span>Modes</span>
                  <span className="mode-popup-hint">
                    <kbd>⇧</kbd> + <kbd>tab</kbd> to switch
                  </span>
                </div>
                {MODE_CYCLE.map((m) => {
                  const item = MODE_META[m];
                  const active = m === permissionMode;
                  return (
                    <button
                      key={m}
                      className={`mode-popup-item ${active ? "active" : ""}`}
                      onClick={() => {
                        onPermissionModeChange(m);
                        setModePopupOpen(false);
                      }}
                    >
                      <div className="mode-popup-icon">{item.icon}</div>
                      <div className="mode-popup-body">
                        <div className="mode-popup-label">{item.label}</div>
                        <div className="mode-popup-desc">
                          {item.description}
                        </div>
                      </div>
                      {active && <span className="mode-popup-check">✓</span>}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {isStreaming ? (
            <button
              className="send-btn stop"
              onClick={onInterrupt}
              title="Stop"
            >
              ◼
            </button>
          ) : (
            <button
              className="send-btn"
              onClick={submit}
              disabled={disabled || (!text.trim() && attachments.length === 0)}
              title="Send"
            >
              ↑
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
