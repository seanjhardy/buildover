import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { PendingPermission } from "../hooks/useAgent.js";

type AllowResult = {
  behavior: "allow";
  updatedInput?: Record<string, unknown>;
  updatedPermissions?: unknown[];
};
type DenyResult = {
  behavior: "deny";
  message: string;
  interrupt?: boolean;
};
type Result = AllowResult | DenyResult;

interface Props {
  pending: PendingPermission;
  onRespond: (requestId: string, result: Result) => void;
}

// Mirrors the extension's `permissionRequestContainer` shell: a per-tool
// body up top, then a button row with numeric shortcut chips (1/2/3) and an
// optional reject text input. Esc rejects, digits invoke buttons. The
// composer is hidden while a request is pending; this card replaces it.
export function PermissionPrompt({ pending, onRespond }: Props) {
  const [feedback, setFeedback] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const branch = buildBranch(pending);

  // Guard against "click-through" accidents: when the user clicks a chat in
  // the sidebar the same pointer-up event can land on a button that renders
  // into the same screen position. We keep buttons non-interactive for a
  // short window after mount so that an in-flight click cannot fire them.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(false);
    const t = setTimeout(() => setReady(true), 350);
    return () => clearTimeout(t);
  }, [pending.requestId]);

  useEffect(() => {
    containerRef.current?.focus();
  }, [pending.requestId]);

  const sendDeny = (interrupt: boolean) =>
    onRespond(pending.requestId, {
      behavior: "deny",
      message: feedback.trim() || branch.defaultRejectMessage,
      interrupt,
    });

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Block all keyboard shortcuts until the prompt is ready (mount-delay guard).
    if (!ready) return;
    if (e.key === "Escape") {
      e.preventDefault();
      sendDeny(true);
      return;
    }
    // Don't hijack number keys when typing in inputs/textareas.
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;

    if (e.key === "1") branch.actions[0]?.invoke();
    else if (e.key === "2") branch.actions[1]?.invoke();
    else if (e.key === "3") branch.actions[2]?.invoke();
  };

  return (
    <div
      ref={containerRef}
      className="permission"
      data-tool={pending.toolName}
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <div className="permission-header">{branch.header}</div>
      <div className="permission-body">{branch.body}</div>

      {branch.showRejectInput && (
        <input
          className="permission-reject-input"
          placeholder="Tell Claude what to do instead"
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
        />
      )}

      <div className="permission-actions">
        {branch.actions.map((action, i) => (
          <button
            key={action.label}
            className={`btn ${action.kind === "primary" ? "btn-primary" : ""} ${action.kind === "danger" ? "btn-danger" : ""}`}
            onClick={action.invoke}
            disabled={!ready || action.disabled}
          >
            <span className="shortcut-num">{i + 1}</span>
            {action.dynamicLabel?.(feedback) ?? action.label}
          </button>
        ))}
      </div>
      <div className="permission-hints">Esc to cancel</div>
    </div>
  );

  // -- branch helpers below as captured closures --
  function buildBranch(p: PendingPermission): Branch {
    const respond = (r: Result) => onRespond(p.requestId, r);
    const inputAny = p.input as Record<string, unknown>;

    if (p.toolName === "AskUserQuestion") {
      return askQuestionBranch(p, respond);
    }
    if (p.toolName === "ExitPlanMode") {
      return exitPlanBranch(p, respond, () => sendDeny(false));
    }
    if (p.toolName === "RequestUserAttention") {
      return acknowledgementBranch(p, respond, (interrupt) => sendDeny(interrupt));
    }

    const headerText = headerForTool(p.toolName, inputAny);
    return {
      header: headerText,
      body: <GenericBody toolName={p.toolName} input={p.input} />,
      showRejectInput: true,
      defaultRejectMessage: "User denied",
      actions: [
        {
          label: "Yes",
          kind: "primary",
          invoke: () => respond({ behavior: "allow" }),
        },
        {
          label: "Yes, and don't ask again",
          kind: "default",
          invoke: () =>
            respond({
              behavior: "allow",
              updatedPermissions: [
                {
                  type: "addRules",
                  rules: [{ toolName: p.toolName }],
                  behavior: "allow",
                  destination: "session",
                },
              ],
            }),
        },
        {
          label: "No",
          kind: "default",
          dynamicLabel: (fb) =>
            fb.trim() ? "Send feedback and deny" : "No",
          invoke: () => sendDeny(!feedback.trim()),
        },
      ],
    };
  }
}

interface Action {
  label: string;
  kind?: "primary" | "default" | "danger";
  invoke: () => void;
  disabled?: boolean;
  dynamicLabel?: (feedback: string) => string;
}

interface Branch {
  header: React.ReactNode;
  body: React.ReactNode;
  showRejectInput: boolean;
  defaultRejectMessage: string;
  actions: Action[];
}

// Per-tool header text, lifted from the extension's tool-class
// `permissionRequest()` overrides.
function headerForTool(name: string, input: Record<string, unknown>): React.ReactNode {
  const path = String(input.file_path ?? "");
  const basename = path ? path.split("/").pop() : "";
  switch (name) {
    case "Bash":
      return "Allow this bash command?";
    case "Write":
      return (
        <>
          Allow write to <span className="permission-path">{basename}</span>?
        </>
      );
    case "Read":
      return (
        <>
          Allow reading from{" "}
          <span className="permission-path">{basename}</span>?
        </>
      );
    case "Edit":
    case "MultiEdit":
      return (
        <>
          Allow edit to <span className="permission-path">{basename}</span>?
        </>
      );
    case "Glob":
      return "Allow glob search?";
    case "Grep":
      return "Allow searching for this query?";
    case "WebFetch":
      return "Allow fetching this url?";
    case "WebSearch":
      return "Allow this web search?";
    default:
      return (
        <>
          Do you want to proceed with <strong>{name}</strong>?
        </>
      );
  }
}

function GenericBody({
  toolName,
  input,
}: {
  toolName: string;
  input: unknown;
}) {
  const i = (input ?? {}) as Record<string, unknown>;

  if (toolName === "Bash") {
    return (
      <pre className="permission-bash">{String(i.command ?? "")}</pre>
    );
  }
  if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit") {
    return (
      <pre className="permission-input">
        {(i.content ?? i.new_string ?? JSON.stringify(input, null, 2)) as string}
      </pre>
    );
  }
  if (toolName === "WebFetch" || toolName === "WebSearch") {
    return (
      <pre className="permission-input">{String(i.url ?? i.query ?? "")}</pre>
    );
  }
  return (
    <details className="permission-details">
      <summary>Details</summary>
      <pre className="permission-input">
        {JSON.stringify(input, null, 2)}
      </pre>
    </details>
  );
}

// ---- ExitPlanMode ----

function exitPlanBranch(
  pending: PendingPermission,
  respond: (r: Result) => void,
  defaultDeny: () => void,
): Branch {
  const plan = String((pending.input as any).plan ?? "");
  return {
    header: "Claude's Plan",
    body: (
      <div className="plan-body assistant-text">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{plan}</ReactMarkdown>
      </div>
    ),
    showRejectInput: true,
    defaultRejectMessage: "User chose to stay in plan mode and continue planning",
    actions: [
      {
        label: "Yes, and auto-accept",
        kind: "primary",
        invoke: () =>
          respond({
            behavior: "allow",
            updatedPermissions: [
              {
                type: "setMode",
                mode: "acceptEdits",
                destination: "session",
              },
            ],
          }),
      },
      {
        label: "Yes, and manually approve edits",
        kind: "default",
        invoke: () =>
          respond({
            behavior: "allow",
            updatedPermissions: [
              {
                type: "setMode",
                mode: "default",
                destination: "session",
              },
            ],
          }),
      },
      {
        label: "No, keep planning",
        kind: "default",
        dynamicLabel: (fb) =>
          fb.trim() ? "Send feedback and keep planning" : "No, keep planning",
        invoke: defaultDeny,
      },
    ],
  };
}

// ---- RequestUserAttention ----

function acknowledgementBranch(
  pending: PendingPermission,
  respond: (r: Result) => void,
  sendDenyWithFeedback: (interrupt: boolean) => void,
): Branch {
  const input = pending.input as { message?: string; summary?: string };
  const message = String(
    input.message ??
      "Your attention is needed before continuing.",
  );
  const summary = input.summary ? String(input.summary) : undefined;

  return {
    header: "Attention needed",
    body: (
      <div className="plan-body assistant-text">
        <p style={{ margin: "0 0 8px" }}>{message}</p>
        {summary && (
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{summary}</ReactMarkdown>
        )}
      </div>
    ),
    showRejectInput: true,
    defaultRejectMessage: "User provided feedback",
    actions: [
      {
        label: "Continue",
        kind: "primary",
        invoke: () => respond({ behavior: "allow" }),
      },
      {
        label: "Send feedback",
        kind: "default",
        dynamicLabel: (fb) =>
          fb.trim() ? "Send feedback and continue" : "Send feedback",
        invoke: () => sendDenyWithFeedback(false),
      },
      {
        label: "Stop",
        kind: "default",
        invoke: () => sendDenyWithFeedback(true),
      },
    ],
  };
}

// ---- AskUserQuestion ----

interface AskQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: Array<{ label: string; description?: string }>;
}

function askQuestionBranch(
  pending: PendingPermission,
  respond: (r: Result) => void,
): Branch {
  // Each question has its own answer; AskShell holds the state. We thread
  // a ref-like via local component state by lifting into a wrapper.
  return {
    header: "Claude is asking",
    body: <AskShell pending={pending} respond={respond} />,
    showRejectInput: false,
    defaultRejectMessage: "User skipped",
    // Actions live inside the shell so we can disable Submit until valid.
    // The outer shell's button row is empty here.
    actions: [],
  };
}

function AskShell({
  pending,
  respond,
}: {
  pending: PendingPermission;
  respond: (r: Result) => void;
}) {
  const questions = ((pending.input as any).questions ?? []) as AskQuestion[];
  const [active, setActive] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [otherText, setOtherText] = useState<Record<string, string>>({});

  const currentQ = questions[active];

  const isAnswered = (q: AskQuestion) => {
    const list = answers[q.question] ?? [];
    return list.length > 0;
  };
  const allAnswered = questions.every(isAnswered);

  const toggle = (q: AskQuestion, label: string) => {
    setAnswers((prev) => {
      const cur = prev[q.question] ?? [];
      if (q.multiSelect) {
        const next = cur.includes(label)
          ? cur.filter((x) => x !== label)
          : [...cur, label];
        return { ...prev, [q.question]: next };
      }
      // Radio: replace, then auto-advance after a short confirm flash.
      return { ...prev, [q.question]: [label] };
    });
    if (!q.multiSelect && active < questions.length - 1) {
      setTimeout(() => setActive((a) => a + 1), 280);
    }
  };

  const submit = () => {
    const resolved: Record<string, string | string[]> = {};
    for (const q of questions) {
      const list = (answers[q.question] ?? []).map((v) =>
        v === "Other" ? otherText[q.question] ?? "Other" : v,
      );
      resolved[q.question] = q.multiSelect ? list : list[0] ?? "";
    }
    respond({
      behavior: "allow",
      updatedInput: { ...pending.input, answers: resolved },
    });
  };

  return (
    <div className="ask">
      <div className="ask-tabs">
        {questions.map((q, i) => (
          <button
            key={i}
            className={`ask-tab ${i === active ? "active" : ""} ${isAnswered(q) ? "answered" : ""}`}
            onClick={() => setActive(i)}
          >
            {q.header ?? `Q${i + 1}`}
          </button>
        ))}
      </div>
      {currentQ && (
        <div className="ask-question">
          <div className="ask-question-text">{currentQ.question}</div>
          <div className="ask-options">
            {currentQ.options.map((opt) => {
              const selected = (answers[currentQ.question] ?? []).includes(
                opt.label,
              );
              return (
                <div
                  key={opt.label}
                  className={`ask-option ${selected ? "selected" : ""}`}
                  role={currentQ.multiSelect ? "checkbox" : "radio"}
                  aria-checked={selected}
                  onClick={() => toggle(currentQ, opt.label)}
                >
                  <Indicator
                    multiSelect={currentQ.multiSelect}
                    selected={selected}
                  />
                  <div className="ask-option-content">
                    <div className="ask-option-label">{opt.label}</div>
                    {opt.description && (
                      <div className="ask-option-desc">{opt.description}</div>
                    )}
                  </div>
                </div>
              );
            })}
            {/* "Other" is always present per the harness convention. */}
            {(() => {
              const selected = (answers[currentQ.question] ?? []).includes(
                "Other",
              );
              return (
                <div
                  className={`ask-option ${selected ? "selected" : ""}`}
                  role={currentQ.multiSelect ? "checkbox" : "radio"}
                  onClick={() => toggle(currentQ, "Other")}
                >
                  <Indicator
                    multiSelect={currentQ.multiSelect}
                    selected={selected}
                  />
                  <div className="ask-option-content">
                    <div className="ask-option-label">Other</div>
                    {selected && (
                      <input
                        className="ask-other-input"
                        placeholder="Type your answer…"
                        value={otherText[currentQ.question] ?? ""}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) =>
                          setOtherText((s) => ({
                            ...s,
                            [currentQ.question]: e.target.value,
                          }))
                        }
                        autoFocus
                      />
                    )}
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
      )}
      <div className="permission-actions ask-actions">
        <button
          className="btn btn-primary"
          disabled={!allAnswered}
          onClick={submit}
        >
          <span className="shortcut-num">1</span>
          Submit answers
        </button>
        <button
          className="btn"
          onClick={() =>
            respond({
              behavior: "deny",
              message: "User skipped",
              interrupt: false,
            })
          }
        >
          <span className="shortcut-num">2</span>
          Skip
        </button>
      </div>
    </div>
  );
}

function Indicator({
  multiSelect,
  selected,
}: {
  multiSelect?: boolean;
  selected: boolean;
}) {
  if (multiSelect) {
    return (
      <div className={`indicator checkbox ${selected ? "checked" : ""}`}>
        {selected && (
          <svg viewBox="0 0 16 16" width="10" height="10">
            <path
              d="M2 8 L6 12 L14 4"
              stroke="currentColor"
              strokeWidth="2"
              fill="none"
            />
          </svg>
        )}
      </div>
    );
  }
  return (
    <div className={`indicator radio ${selected ? "checked" : ""}`}>
      {selected && <div className="radio-dot" />}
    </div>
  );
}
