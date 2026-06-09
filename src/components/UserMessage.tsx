import { memo, useEffect, useRef, useState } from "react";
import { Paperclip, X } from "lucide-react";
import type { BranchInfo } from "../hooks/useAgent.js";
import type { Attachment } from "../types.js";
import { AttachmentChip } from "./AttachmentChip.js";
import { AttachmentPreviewModal } from "./AttachmentPreviewModal.js";

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_TEXT_BYTES = 256 * 1024;
const SUPPORTED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];

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
      throw new Error(
        `Image too large (max ${MAX_IMAGE_BYTES / 1024 / 1024}MB)`,
      );
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

interface Props {
  text: string;
  attachments?: Attachment[];
  messageId: string;
  branchInfo?: BranchInfo;      // present when forks exist at this message
  isStreaming: boolean;
  checkpointId?: string;        // set when this turn can be reverted
  onFork: (userMessageId: string, newText: string, attachments?: Attachment[]) => void;
  onRevert?: (checkpointId: string) => void;
  onSwitchBranch: (parentMessageId: string, targetBranchId: string) => void;
}

const PencilIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
  </svg>
);

export const UserMessage = memo(function UserMessage({
  text,
  attachments,
  messageId,
  branchInfo,
  isStreaming,
  checkpointId,
  onFork,
  onRevert,
  onSwitchBranch,
}: Props) {
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState(text);
  const [editAttachments, setEditAttachments] = useState<Attachment[]>(attachments || []);
  const [previewAttachment, setPreviewAttachment] = useState<Attachment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reset draft if the underlying message text or attachments change (e.g. branch switch).
  useEffect(() => {
    setEditText(text);
    setEditAttachments(attachments || []);
  }, [text, attachments]);

  // Auto-focus + select-all when edit mode opens.
  useEffect(() => {
    if (isEditing && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.select();
    }
  }, [isEditing]);

  const handleSubmit = () => {
    const trimmed = editText.trim();
    // Allow submitting if there's either text or attachments (or both)
    if (!trimmed && editAttachments.length === 0) {
      setIsEditing(false);
      setEditText(text);
      setEditAttachments(attachments || []);
      return;
    }
    // Check if anything actually changed
    const textChanged = trimmed !== text;
    const attachmentsChanged = JSON.stringify(editAttachments) !== JSON.stringify(attachments || []);
    if (!textChanged && !attachmentsChanged) {
      setIsEditing(false);
      return;
    }
    onFork(messageId, trimmed, editAttachments.length > 0 ? editAttachments : undefined);
    setIsEditing(false);
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
    if (next.length) setEditAttachments((a) => [...a, ...next]);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
    if (e.key === "Escape") {
      setIsEditing(false);
      setEditText(text);
    }
  };

  // Branch navigation: variants[0] is always the active trunk.
  const hasBranches = branchInfo && branchInfo.variants.length > 1;
  const activeIdx = 0; // trunk is always index 0 in variants
  const totalVariants = branchInfo?.variants.length ?? 1;

  const goPrev = () => {
    if (!branchInfo || activeIdx <= 0) return;
    const prev = branchInfo.variants[activeIdx - 1];
    if (prev.branchId) onSwitchBranch(branchInfo.parentMessageId, prev.branchId);
  };

  const goNext = () => {
    if (!branchInfo || activeIdx >= totalVariants - 1) return;
    const next = branchInfo.variants[activeIdx + 1];
    if (next.branchId) onSwitchBranch(branchInfo.parentMessageId, next.branchId);
  };

  return (
    <div className="message user">
      {/* Wrapper provides the max-width constraint and stacks bubble + action bar */}
      <div className="bubble-wrapper">
        {isEditing ? (
          /* ---- Edit mode ---- */
          <div className="bubble bubble--editing">
            {error && <div className="bubble-edit-error">{error}</div>}
            {editAttachments.length > 0 && (
              <div className="bubble-attachments">
                {editAttachments.map((a) => (
                  <AttachmentChip
                    key={a.id}
                    attachment={a}
                    compact
                    onClick={() => setPreviewAttachment(a)}
                    onRemove={() => setEditAttachments((list) => list.filter((x) => x.id !== a.id))}
                  />
                ))}
              </div>
            )}
            <textarea
              ref={textareaRef}
              className="bubble-edit-textarea"
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={Math.max(2, editText.split("\n").length)}
            />
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
            <div className="bubble-edit-actions">
              {/* Branch navigation — left side of actions bar */}
              {hasBranches && (
                <div className="branch-nav">
                  <button
                    className="branch-nav-arrow"
                    onClick={goPrev}
                    disabled={activeIdx <= 0}
                    title="Previous version"
                    aria-label="Previous version"
                  >
                    ←
                  </button>
                  <span className="branch-nav-indicator">
                    {activeIdx + 1} / {totalVariants}
                  </span>
                  <button
                    className="branch-nav-arrow"
                    onClick={goNext}
                    disabled={activeIdx >= totalVariants - 1}
                    title="Next version"
                    aria-label="Next version"
                  >
                    →
                  </button>
                </div>
              )}
              <div className="bubble-edit-btns">
                <button
                  className="bubble-edit-attach"
                  onClick={() => fileInputRef.current?.click()}
                  title="Add files"
                  aria-label="Add files"
                >
                  <Paperclip size={14} />
                </button>
                <button
                  className="bubble-edit-cancel"
                  onClick={() => {
                    setIsEditing(false);
                    setEditText(text);
                    setEditAttachments(attachments || []);
                    setError(null);
                  }}
                >
                  Cancel
                </button>
                <button
                  className="bubble-edit-submit"
                  onClick={handleSubmit}
                  disabled={
                    (editText.trim() === "" && editAttachments.length === 0) ||
                    (editText.trim() === text && JSON.stringify(editAttachments) === JSON.stringify(attachments || []))
                  }
                >
                  Send
                </button>
              </div>
            </div>
          </div>
        ) : (
          /* ---- Display mode ---- */
          <>
            <div className="bubble">
              {attachments && attachments.length > 0 && (
                <div className="bubble-attachments">
                  {attachments.map((a) => (
                    <AttachmentChip
                      key={a.id}
                      attachment={a}
                      compact
                      onClick={() => setPreviewAttachment(a)}
                    />
                  ))}
                </div>
              )}
              {text}
            </div>
            {/* Action bar — appears below the bubble on hover */}
            {!isStreaming && (
              <div className="bubble-actions">
                <button
                  className="bubble-edit-btn"
                  onClick={() => setIsEditing(true)}
                  title="Edit message"
                  aria-label="Edit message"
                >
                  <PencilIcon />
                </button>
                {checkpointId && onRevert && (
                  <button
                    className="bubble-revert-btn"
                    onClick={() => onRevert(checkpointId)}
                    title="Revert to before this message"
                  >
                    ↩ Revert
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
      {previewAttachment && (
        <AttachmentPreviewModal
          attachment={previewAttachment}
          onClose={() => setPreviewAttachment(null)}
        />
      )}
    </div>
  );
});
