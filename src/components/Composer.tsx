import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Archive,
  ArrowUp,
  Bot,
  ClipboardList,
  Hammer,
  ListPlus,
  MessageCircleQuestion,
  Mic,
  Paperclip,
  Settings,
  ShieldOff,
  Square,
  Terminal,
  Trash2,
} from "lucide-react";
import {
  type Attachment,
  type ContextUsage,
  type Model,
  type PermissionMode,
} from "../types.js";
import { AttachmentChip } from "./AttachmentChip.js";
import { ContextRing } from "./ContextRing.js";
import { useTranscription } from "../hooks/useTranscription.js";
import { fileApi } from "../lib/api.js";

interface Props {
  chatId: string;
  onSend: (text: string, attachments: Attachment[]) => void;
  onQueueMessage?: (text: string, attachments: Attachment[]) => void;
  onInterrupt: () => void;
  onDraftChange?: (text: string) => void;
  disabled: boolean;
  isStreaming: boolean;
  model: Model;
  permissionMode: PermissionMode;
  onPermissionModeChange: (m: PermissionMode) => void;
  onToggleMcp: () => void;
  contextUsage?: ContextUsage | null;
  repoPath?: string;
  /** SDK skill names from system_init, e.g. ["review", "simplify", "compact"] */
  sdkSlashCommands?: string[];
  /** Hide the permissions/mode pill (e.g. in compact embedded contexts) */
  hideModePill?: boolean;
  onModelChange: (model: string) => void;
  availableModels: { id: string; label: string }[];
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
  { label: string; description: string; icon: ReactNode }
> = {
  default: {
    label: "Ask before edits",
    description: "Claude will ask for approval before making each edit",
    icon: <MessageCircleQuestion size={13} />,
  },
  acceptEdits: {
    label: "Edit automatically",
    description: "Claude will edit your selected text or the whole file",
    icon: <Hammer size={13} />,
  },
  plan: {
    label: "Plan mode",
    description:
      "Claude will explore the code and present a plan before editing",
    icon: <ClipboardList size={13} />,
  },
  bypassPermissions: {
    label: "Bypass permissions",
    description:
      "Claude will not ask for approval before running potentially dangerous commands",
    icon: <ShieldOff size={13} />,
  },
};

// ---- Slash commands ----
// Two action types:
//   "permission" — changes the current permission mode and clears the command from the textarea
//   "text"       — inserts "/" + key into the textarea so the user can add args then send
type SlashCommandAction =
  | { type: "permission"; mode: PermissionMode }
  | { type: "text" };

// Group for organising the popup into sections.
type SlashCommandGroup = "modes" | "session" | "skills";
const GROUP_LABELS: Record<SlashCommandGroup, string> = {
  modes: "Modes",
  session: "Session",
  skills: "Skills",
};
const GROUP_ORDER: SlashCommandGroup[] = ["modes", "session", "skills"];

interface SlashCommand {
  key: string;
  label: string;
  description: string;
  icon: ReactNode;
  action: SlashCommandAction;
  group: SlashCommandGroup;
}

// Built-in commands that are always present.
const BUILTIN_SLASH_COMMANDS: SlashCommand[] = [
  {
    key: "plan",
    label: "Plan mode",
    description: "Claude will explore code and present a plan",
    icon: <ClipboardList size={13} />,
    action: { type: "permission", mode: "plan" },
    group: "modes",
  },
  {
    key: "auto",
    label: "Edit automatically",
    description: "Claude will edit without asking for approval",
    icon: <Hammer size={13} />,
    action: { type: "permission", mode: "acceptEdits" },
    group: "modes",
  },
  {
    key: "ask",
    label: "Ask before edits",
    description: "Claude will ask for approval before each edit",
    icon: <MessageCircleQuestion size={13} />,
    action: { type: "permission", mode: "default" },
    group: "modes",
  },
  {
    key: "yolo",
    label: "Bypass permissions",
    description: "Claude will not ask before running commands",
    icon: <ShieldOff size={13} />,
    action: { type: "permission", mode: "bypassPermissions" },
    group: "modes",
  },
  {
    key: "compact",
    label: "Compact conversation",
    description: "Summarise the conversation to free up context window",
    icon: <Archive size={13} />,
    action: { type: "text" },
    group: "session",
  },
  {
    key: "clear",
    label: "Clear conversation",
    description: "Start a fresh conversation with a new session",
    icon: <Trash2 size={13} />,
    action: { type: "text" },
    group: "session",
  },
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

export function Composer(props: Props) {
  const {
    chatId,
    onSend,
    onQueueMessage,
    onInterrupt,
    onDraftChange,
    disabled,
    isStreaming,
    model,
    permissionMode,
    onPermissionModeChange,
    onModelChange,
    availableModels,
    onToggleMcp,
    contextUsage,
    repoPath,
    sdkSlashCommands = [],
    hideModePill = false,
  } = props;

  // Merge built-in commands with SDK skills. SDK skills that already have a
  // built-in entry (matched by key) are skipped so built-ins always win.
  const builtinKeys = new Set(BUILTIN_SLASH_COMMANDS.map((c) => c.key));
  const allSlashCommands: SlashCommand[] = [
    ...BUILTIN_SLASH_COMMANDS,
    ...sdkSlashCommands
      .filter((name) => !builtinKeys.has(name))
      .map((name) => ({
        key: name,
        label: name.charAt(0).toUpperCase() + name.slice(1).replace(/-/g, " "),
        description: `Run the /${name} skill`,
        icon: <Terminal size={13} />,
        action: { type: "text" } as SlashCommandAction,
        group: "skills" as SlashCommandGroup,
      })),
  ];

  const DRAFT_KEY = `buildover.draft.${chatId}`;

  const [text, setText] = useState(() => {
    try {
      return localStorage.getItem(DRAFT_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftNotifyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modePopupOpen, setModePopupOpen] = useState(false);
  const [modelPopupOpen, setModelPopupOpen] = useState(false);
  const [plusPopupOpen, setPlusPopupOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const modeWrapRef = useRef<HTMLDivElement>(null);
  const modelWrapRef = useRef<HTMLDivElement>(null);
  const plusWrapRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // ---- @ file popup state ----
  const [atPopupOpen, setAtPopupOpen] = useState(false);
  const [atQuery, setAtQuery] = useState("");
  const [atFiles, setAtFiles] = useState<string[]>([]);
  const [atHighlightIndex, setAtHighlightIndex] = useState(0);
  const atSearchRef = useRef<HTMLInputElement>(null);
  const atWrapRef = useRef<HTMLDivElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);

  // ---- / command popup state ----
  const [slashPopupOpen, setSlashPopupOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [slashHighlightIndex, setSlashHighlightIndex] = useState(0);
  const slashWrapRef = useRef<HTMLDivElement>(null);

  // Debounce-save the draft text to localStorage and notify parent.
  const saveDraft = (value: string) => {
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(() => {
      try {
        if (value) {
          localStorage.setItem(DRAFT_KEY, value);
        } else {
          localStorage.removeItem(DRAFT_KEY);
        }
      } catch {
        // localStorage unavailable — silently ignore
      }
    }, 300);
    // Debounce the parent notification to avoid a top-level App re-render (and
    // cascading re-renders of all message components) on every keystroke.
    if (draftNotifyTimerRef.current) clearTimeout(draftNotifyTimerRef.current);
    draftNotifyTimerRef.current = setTimeout(() => {
      onDraftChange?.(value);
    }, 300);
  };

  const transcription = useTranscription({
    onTranscript: (transcript) => {
      // Replace the textarea content with the latest Whisper output directly.
      // We deliberately do NOT snapshot and re-prepend the text that was in
      // the box when recording started: if the user deletes or edits text
      // while the mic is running, those changes must be respected. The
      // transcript is always the authoritative live value during recording.
      setText(transcript);
      saveDraft(transcript);
    },
  });

  const toggleMic = async () => {
    if (transcription.state === "recording") {
      await transcription.stop();
      return;
    }
    if (transcription.state === "transcribing") return;
    setError(null);
    await transcription.start();
  };

  // Close popups on outside click.
  useEffect(() => {
    if (!modePopupOpen && !modelPopupOpen && !plusPopupOpen && !atPopupOpen && !slashPopupOpen)
      return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      if (modePopupOpen && !modeWrapRef.current?.contains(target)) {
        setModePopupOpen(false);
      }
      if (modelPopupOpen && !modelWrapRef.current?.contains(target)) {
        setModelPopupOpen(false);
      }
      if (plusPopupOpen && !plusWrapRef.current?.contains(target)) {
        setPlusPopupOpen(false);
      }
      if (atPopupOpen && !atWrapRef.current?.contains(target)) {
        setAtPopupOpen(false);
      }
      if (slashPopupOpen && !slashWrapRef.current?.contains(target)) {
        setSlashPopupOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [modePopupOpen, modelPopupOpen, plusPopupOpen, atPopupOpen, slashPopupOpen]);

  // Auto-resize textarea to fit content, up to a maximum height.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  // Lazy-load file list the first time the @ popup opens.
  useEffect(() => {
    if (!atPopupOpen || !repoPath || atFiles.length > 0) return;
    fileApi
      .listFiles(repoPath)
      .then(setAtFiles)
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atPopupOpen, repoPath]);

  // Focus the search input when the @ popup opens.
  useEffect(() => {
    if (atPopupOpen) setTimeout(() => atSearchRef.current?.focus(), 0);
  }, [atPopupOpen]);

  // Reset highlight indices when queries change.
  useEffect(() => {
    setAtHighlightIndex(0);
  }, [atQuery]);
  useEffect(() => {
    setSlashHighlightIndex(0);
  }, [slashQuery]);

  const cycleMode = () => {
    const idx = MODE_CYCLE.indexOf(permissionMode);
    const next = MODE_CYCLE[(idx + 1) % MODE_CYCLE.length];
    onPermissionModeChange(next);
  };

  const clearDraft = () => {
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    if (draftNotifyTimerRef.current) clearTimeout(draftNotifyTimerRef.current);
    try {
      localStorage.removeItem(DRAFT_KEY);
    } catch {
      // ignore
    }
    // Call immediately (not debounced) so the sidebar clears the draft preview
    // right away when a message is sent.
    onDraftChange?.("");
  };

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return;
    if (disabled) {
      // If we have a queue handler, queue the message instead of dropping it
      if (onQueueMessage) {
        onQueueMessage(trimmed, attachments);
        setText("");
        setAttachments([]);
        clearDraft();
      }
      return;
    }
    onSend(trimmed, attachments);
    setText("");
    setAttachments([]);
    clearDraft();
  };

  // Explicitly queue a message regardless of streaming state.
  const queueSubmit = () => {
    if (!onQueueMessage) return;
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return;
    onQueueMessage(trimmed, attachments);
    setText("");
    setAttachments([]);
    clearDraft();
  };

  // Replace the @<query> token with the selected file path.
  const selectAtFile = (filePath: string) => {
    const el = textareaRef.current;
    if (!el) return;
    const cursor = el.selectionStart ?? el.value.length;
    const before = el.value.slice(0, cursor);
    const replaced = before.replace(/@([^\s@]*)$/, `@${filePath}`);
    const newText = replaced + el.value.slice(cursor);
    setText(newText);
    saveDraft(newText);
    setAtPopupOpen(false);
    setAtQuery("");
    requestAnimationFrame(() => {
      el.setSelectionRange(replaced.length, replaced.length);
      el.focus();
    });
  };

  // Handle slash command selection.
  // - "permission" commands: clear the token, apply the mode.
  // - "text" commands: replace the partial token with "/<key> " so the user
  //   can optionally add arguments before pressing Enter to send.
  const selectSlashCommand = (cmd: SlashCommand) => {
    const el = textareaRef.current;
    if (!el) return;
    const cursor = el.selectionStart ?? el.value.length;
    const before = el.value.slice(0, cursor);

    if (cmd.action.type === "permission") {
      // Remove the /token entirely and apply the mode.
      const replaced = before.replace(/(?:^|\n)\/[^\s]*$/, (m) =>
        m.startsWith("\n") ? "\n" : "",
      );
      const newText = replaced + el.value.slice(cursor);
      setText(newText);
      saveDraft(newText);
      onPermissionModeChange(cmd.action.mode);
      setSlashPopupOpen(false);
      setSlashQuery("");
      requestAnimationFrame(() => {
        el.setSelectionRange(replaced.length, replaced.length);
        el.focus();
      });
    } else {
      // Replace the partial /token with the full "/<key> " so the user can
      // type optional arguments and then press Enter to send.
      const insertion = `/${cmd.key} `;
      const replaced = before.replace(/(?:^|\n)\/[^\s]*$/, (m) =>
        m.startsWith("\n") ? `\n${insertion}` : insertion,
      );
      const newText = replaced + el.value.slice(cursor);
      setText(newText);
      saveDraft(newText);
      setSlashPopupOpen(false);
      setSlashQuery("");
      requestAnimationFrame(() => {
        el.setSelectionRange(replaced.length, replaced.length);
        el.focus();
      });
    }
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

  // Renders `text` as React nodes, wrapping any /command token (at the start of the
  // string or after a newline) in a <span class="slash-token"> so the mirror div can
  // display a coloured pill behind it.  The mirror itself is `color: transparent`, so
  // only the span's background-color is visible through the transparent textarea.
  const renderHighlighted = (raw: string): React.ReactNode => {
    if (!raw || !raw.includes("/")) return raw;
    const parts: React.ReactNode[] = [];
    const regex = /(^|\n)(\/\S*)/g;
    let last = 0;
    let k = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(raw)) !== null) {
      const prefix = m[1]; // '' or '\n'
      const token = m[2];  // '/command…'
      if (m.index > last) parts.push(raw.slice(last, m.index));
      if (prefix) parts.push(prefix);
      parts.push(<span key={k++} className="slash-token">{token}</span>);
      last = m.index + m[0].length;
    }
    if (last < raw.length) parts.push(raw.slice(last));
    return <>{parts}</>;
  };

  // Derived filtered lists (computed at render time for use in JSX + keyboard handlers).
  const atFilesFiltered = atFiles
    .filter(
      (f) => atQuery === "" || f.toLowerCase().includes(atQuery.toLowerCase()),
    )
    .slice(0, 50);
  const slashCommandsFiltered = allSlashCommands.filter((c) =>
    c.key.startsWith(slashQuery.toLowerCase()),
  );

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

      <div className="composer-input-wrap">
        {/* ---- @ file search popup ---- */}
        {atPopupOpen && (
          <div
            ref={atWrapRef}
            className="at-popup"
            role="listbox"
            aria-label="File search"
          >
            <input
              ref={atSearchRef}
              className="at-popup-search"
              placeholder="Search files…"
              value={atQuery}
              onChange={(e) => setAtQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setAtHighlightIndex((i) =>
                    Math.min(i + 1, atFilesFiltered.length - 1),
                  );
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setAtHighlightIndex((i) => Math.max(i - 1, 0));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  const chosen = atFilesFiltered[atHighlightIndex];
                  if (chosen) selectAtFile(chosen);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setAtPopupOpen(false);
                  textareaRef.current?.focus();
                }
              }}
            />
            <div className="at-popup-list">
              {atFilesFiltered.length === 0 && (
                <div className="at-popup-empty">
                  {atFiles.length === 0 ? "Loading files…" : "No files match"}
                </div>
              )}
              {atFilesFiltered.map((filePath, i) => {
                const parts = filePath.split("/");
                const basename = parts[parts.length - 1];
                const dir = parts.slice(0, -1).join("/");
                return (
                  <button
                    key={filePath}
                    className={`inline-popup-item${i === atHighlightIndex ? " highlighted" : ""}`}
                    role="option"
                    aria-selected={i === atHighlightIndex}
                    onMouseDown={(e) => {
                      e.preventDefault(); // prevent textarea losing focus
                      selectAtFile(filePath);
                    }}
                    onMouseEnter={() => setAtHighlightIndex(i)}
                  >
                    <span className="inline-popup-item-name">{basename}</span>
                    {dir && (
                      <span className="inline-popup-item-path">{dir}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* ---- / command popup ---- */}
        {slashPopupOpen && (
          <div
            ref={slashWrapRef}
            className="slash-popup"
            role="listbox"
            aria-label="Commands"
          >
            {slashCommandsFiltered.length === 0 ? (
              <div className="at-popup-empty">No matching commands</div>
            ) : slashQuery !== "" ? (
              // Flat filtered list when the user has typed a prefix
              slashCommandsFiltered.map((cmd, i) => (
                <button
                  key={cmd.key}
                  className={`inline-popup-item${i === slashHighlightIndex ? " highlighted" : ""}`}
                  role="option"
                  aria-selected={i === slashHighlightIndex}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    selectSlashCommand(cmd);
                  }}
                  onMouseEnter={() => setSlashHighlightIndex(i)}
                >
                  <span className="popup-item-icon">{cmd.icon}</span>
                  <div>
                    <div className="popup-item-label">/{cmd.key}</div>
                    <div className="popup-item-desc">{cmd.description}</div>
                  </div>
                </button>
              ))
            ) : (
              // Grouped view when just "/" is typed
              GROUP_ORDER.flatMap((group) => {
                const cmds = slashCommandsFiltered.filter((c) => c.group === group);
                if (cmds.length === 0) return [];
                return [
                  <div key={`hdr-${group}`} className="slash-popup-group-header">
                    {GROUP_LABELS[group]}
                  </div>,
                  ...cmds.map((cmd) => {
                    const i = slashCommandsFiltered.indexOf(cmd);
                    return (
                      <button
                        key={cmd.key}
                        className={`inline-popup-item${i === slashHighlightIndex ? " highlighted" : ""}`}
                        role="option"
                        aria-selected={i === slashHighlightIndex}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          selectSlashCommand(cmd);
                        }}
                        onMouseEnter={() => setSlashHighlightIndex(i)}
                      >
                        <span className="popup-item-icon">{cmd.icon}</span>
                        <div>
                          <div className="popup-item-label">/{cmd.key}</div>
                          <div className="popup-item-desc">{cmd.description}</div>
                        </div>
                      </button>
                    );
                  }),
                ];
              })
            )}
          </div>
        )}

        {/* Mirror div — renders the same text with /command tokens highlighted.
            Sits behind the transparent textarea; only the span backgrounds are
            visible (the mirror text itself is color:transparent). */}
        <div
          ref={mirrorRef}
          className="composer-input-mirror"
          aria-hidden="true"
        >
          {renderHighlighted(text)}
        </div>

        <textarea
          ref={textareaRef}
          className="composer-input"
          placeholder={
            disabled
              ? "Claude is working…"
              : permissionMode === "plan"
                ? "Describe what you want Claude to plan…"
                : "Message Claude (@ for files, / for commands)"
          }
          value={text}
          onChange={(e) => {
            const val = e.target.value;
            const cursor = e.target.selectionStart ?? val.length;
            setText(val);
            saveDraft(val);

            // Detect @ trigger: @ followed by non-whitespace before cursor.
            const before = val.slice(0, cursor);
            const atMatch = before.match(/@([^\s@]*)$/);
            if (atMatch) {
              setAtQuery(atMatch[1]);
              setAtPopupOpen(true);
              setSlashPopupOpen(false);
              return;
            }

            // Detect / trigger: only at position 0 or immediately after a newline.
            const slashMatch = before.match(/(?:^|\n)\/([^\s/]*)$/);
            if (slashMatch) {
              setSlashQuery(slashMatch[1]);
              setSlashPopupOpen(true);
              setAtPopupOpen(false);
              return;
            }

            // Neither trigger active — close any open popup.
            setAtPopupOpen(false);
            setSlashPopupOpen(false);
          }}
          onScroll={(e) => {
            if (mirrorRef.current)
              mirrorRef.current.scrollTop = e.currentTarget.scrollTop;
          }}
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
            // ---- @ popup keyboard navigation ----
            if (atPopupOpen) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setAtHighlightIndex((i) =>
                  Math.min(i + 1, atFilesFiltered.length - 1),
                );
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setAtHighlightIndex((i) => Math.max(i - 1, 0));
                return;
              }
              if (e.key === "Enter") {
                e.preventDefault();
                const chosen = atFilesFiltered[atHighlightIndex];
                if (chosen) selectAtFile(chosen);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setAtPopupOpen(false);
                return;
              }
            }

            // ---- / popup keyboard navigation ----
            if (slashPopupOpen) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSlashHighlightIndex((i) =>
                  Math.min(i + 1, slashCommandsFiltered.length - 1),
                );
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setSlashHighlightIndex((i) => Math.max(i - 1, 0));
                return;
              }
              if (e.key === "Enter") {
                e.preventDefault();
                const chosen = slashCommandsFiltered[slashHighlightIndex];
                if (chosen) selectSlashCommand(chosen);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setSlashPopupOpen(false);
                return;
              }
            }

            // ---- Existing shortcuts ----
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
        />
      </div>

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
                  <span className="popup-item-icon">
                    <Paperclip size={13} />
                  </span>
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
                  <span className="popup-item-icon">
                    <Settings size={13} />
                  </span>
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
          <ContextRing contextUsage={contextUsage ?? null} />
        </div>

        <div className="composer-bar-right">
          <button
            className={`mic-btn ${transcription.state}`}
            onClick={() => void toggleMic()}
            disabled={disabled || transcription.state === "transcribing"}
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
              <Mic className="mic-icon" size={14} aria-hidden="true" />
            )}
          </button>
          <div ref={modelWrapRef} className="popup-wrap">
            <button
              className={`model-pill-btn${modelPopupOpen ? " active" : ""}`}
              onClick={() => !isStreaming && setModelPopupOpen((v) => !v)}
              disabled={isStreaming}
              title={availableModels.find((m) => m.id === model)?.label ?? model}
              aria-label="Switch model"
            >
              <Bot size={14} />
            </button>
            {modelPopupOpen && (
              <div className="model-popup" role="listbox">
                <div className="model-popup-head">Model</div>
                {[...availableModels]
                  .sort((a, b) => a.label.localeCompare(b.label))
                  .map((m) => {
                    const active = m.id === model;
                    return (
                      <button
                        key={m.id}
                        role="option"
                        aria-selected={active}
                        className={`model-popup-item${active ? " active" : ""}`}
                        onClick={() => {
                          onModelChange(m.id);
                          setModelPopupOpen(false);
                        }}
                      >
                        <span className="model-popup-label">{m.label}</span>
                        {active && <span className="model-popup-check">✓</span>}
                      </button>
                    );
                  })}
              </div>
            )}
          </div>
          {!hideModePill && <div ref={modeWrapRef} className="popup-wrap">
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
          </div>}

          {onQueueMessage && (
            <button
              className="send-btn queue"
              onClick={queueSubmit}
              disabled={!text.trim() && attachments.length === 0}
              title="Add to queue"
            >
              <ListPlus size={16} />
            </button>
          )}
          {isStreaming ? (
            <button
              className="send-btn stop"
              onClick={onInterrupt}
              title="Stop"
            >
              <Square size={12} />
            </button>
          ) : (
            <button
              className="send-btn"
              onClick={submit}
              disabled={disabled || (!text.trim() && attachments.length === 0)}
              title="Send"
            >
              <ArrowUp size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
