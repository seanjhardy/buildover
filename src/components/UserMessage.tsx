import { memo, useEffect, useRef, useState } from "react";
import type { BranchInfo } from "../hooks/useAgent.js";
import type { Attachment } from "../types.js";
import { AttachmentChip } from "./AttachmentChip.js";
import { AttachmentPreviewModal } from "./AttachmentPreviewModal.js";

interface Props {
  text: string;
  attachments?: Attachment[];
  messageId: string;
  branchInfo?: BranchInfo;      // present when forks exist at this message
  isStreaming: boolean;
  onFork: (userMessageId: string, newText: string) => void;
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
  onFork,
  onSwitchBranch,
}: Props) {
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState(text);
  const [previewAttachment, setPreviewAttachment] = useState<Attachment | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Reset draft if the underlying message text changes (e.g. branch switch).
  useEffect(() => {
    setEditText(text);
  }, [text]);

  // Auto-focus + select-all when edit mode opens.
  useEffect(() => {
    if (isEditing && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.select();
    }
  }, [isEditing]);

  const handleSubmit = () => {
    const trimmed = editText.trim();
    if (!trimmed || trimmed === text) {
      setIsEditing(false);
      setEditText(text);
      return;
    }
    onFork(messageId, trimmed);
    setIsEditing(false);
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
      {/* Wrapper provides the max-width constraint and is the anchor for the pencil button */}
      <div className="bubble-wrapper">
        {isEditing ? (
          /* ---- Edit mode ---- */
          <div className="bubble bubble--editing">
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
            <textarea
              ref={textareaRef}
              className="bubble-edit-textarea"
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={Math.max(2, editText.split("\n").length)}
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
                  className="bubble-edit-cancel"
                  onClick={() => {
                    setIsEditing(false);
                    setEditText(text);
                  }}
                >
                  Cancel
                </button>
                <button
                  className="bubble-edit-submit"
                  onClick={handleSubmit}
                  disabled={!editText.trim() || editText.trim() === text}
                >
                  Send
                </button>
              </div>
            </div>
          </div>
        ) : (
          /* ---- Display mode ---- */
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
        )}

        {/* Pencil button — overlaps bottom-right corner of wrapper, shown on hover */}
        {!isStreaming && !isEditing && (
          <button
            className="bubble-edit-btn"
            onClick={() => setIsEditing(true)}
            title="Edit message"
            aria-label="Edit message"
          >
            <PencilIcon />
          </button>
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
