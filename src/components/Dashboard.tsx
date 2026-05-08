import { useCallback, useEffect, useRef, useState } from "react";
import { Pin, PinOff, Plus, Trash2, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, type Dashboard, type DashboardNote, type TodoItem } from "../lib/api.js";

interface Props {
  onClose: () => void;
}

type Tab = "notes" | "todos";
type Priority = TodoItem["priority"];

const PRIORITY_LABEL: Record<Priority, string> = {
  high: "High",
  medium: "Med",
  low: "Low",
};
const PRIORITY_CLASS: Record<Priority, string> = {
  high: "priority-high",
  medium: "priority-med",
  low: "priority-low",
};

export function DashboardPanel({ onClose }: Props) {
  const [tab, setTab] = useState<Tab>("todos");
  const [data, setData] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // New-note form
  const [noteText, setNoteText] = useState("");
  const [notePinned, setNotePinned] = useState(false);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editingNoteText, setEditingNoteText] = useState("");

  // New-todo form
  const [todoText, setTodoText] = useState("");
  const [todoPriority, setTodoPriority] = useState<Priority>("medium");

  const noteInputRef = useRef<HTMLTextAreaElement>(null);
  const todoInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const d = await api.getDashboard();
      setData(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // ── Notes ──────────────────────────────────────────────────────────────────

  const handleAddNote = async () => {
    const content = noteText.trim();
    if (!content) return;
    try {
      const note = await api.addNote(content, notePinned);
      setData((d) => d ? { ...d, notes: [note, ...d.notes] } : d);
      setNoteText("");
      setNotePinned(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleTogglePin = async (note: DashboardNote) => {
    try {
      const updated = await api.updateNote(note.id, { pinned: !note.pinned });
      setData((d) => d ? { ...d, notes: d.notes.map((n) => n.id === note.id ? updated : n) } : d);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleDeleteNote = async (id: string) => {
    try {
      await api.deleteNote(id);
      setData((d) => d ? { ...d, notes: d.notes.filter((n) => n.id !== id) } : d);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleSaveNoteEdit = async (id: string) => {
    const content = editingNoteText.trim();
    if (!content) return;
    try {
      const updated = await api.updateNote(id, { content });
      setData((d) => d ? { ...d, notes: d.notes.map((n) => n.id === id ? updated : n) } : d);
      setEditingNoteId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // ── Todos ──────────────────────────────────────────────────────────────────

  const handleAddTodo = async () => {
    const text = todoText.trim();
    if (!text) return;
    try {
      const todo = await api.addTodo(text, todoPriority);
      setData((d) => d ? { ...d, todos: [todo, ...d.todos] } : d);
      setTodoText("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleToggleTodo = async (todo: TodoItem) => {
    try {
      const updated = await api.updateTodo(todo.id, { done: !todo.done });
      setData((d) => d ? { ...d, todos: d.todos.map((t) => t.id === todo.id ? updated : t) } : d);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleDeleteTodo = async (id: string) => {
    try {
      await api.deleteTodo(id);
      setData((d) => d ? { ...d, todos: d.todos.filter((t) => t.id !== id) } : d);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleChangeTodoPriority = async (todo: TodoItem, priority: Priority) => {
    try {
      const updated = await api.updateTodo(todo.id, { priority });
      setData((d) => d ? { ...d, todos: d.todos.map((t) => t.id === todo.id ? updated : t) } : d);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const sortedNotes = data
    ? [...data.notes].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0))
    : [];
  const pendingTodos = data?.todos.filter((t) => !t.done) ?? [];
  const doneTodos = data?.todos.filter((t) => t.done) ?? [];

  return (
    <div className="dashboard-panel">
      <div className="dashboard-header">
        <div className="dashboard-tabs">
          <button
            className={`dashboard-tab ${tab === "todos" ? "active" : ""}`}
            onClick={() => setTab("todos")}
          >
            Todos
            {pendingTodos.length > 0 && (
              <span className="dashboard-tab-badge">{pendingTodos.length}</span>
            )}
          </button>
          <button
            className={`dashboard-tab ${tab === "notes" ? "active" : ""}`}
            onClick={() => setTab("notes")}
          >
            Notes
            {sortedNotes.length > 0 && (
              <span className="dashboard-tab-badge">{sortedNotes.length}</span>
            )}
          </button>
        </div>
        <button className="dashboard-close" onClick={onClose} aria-label="Close dashboard">
          <X size={14} />
        </button>
      </div>

      {error && <div className="dashboard-error">{error}</div>}

      <div className="dashboard-body">
        {loading ? (
          <div className="dashboard-loading">Loading…</div>
        ) : tab === "todos" ? (
          <>
            {/* Add todo */}
            <div className="dashboard-add-row">
              <input
                ref={todoInputRef}
                className="dashboard-input"
                placeholder="Add a todo…"
                value={todoText}
                onChange={(e) => setTodoText(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void handleAddTodo(); }}
              />
              <select
                className="dashboard-priority-select"
                value={todoPriority}
                onChange={(e) => setTodoPriority(e.target.value as Priority)}
                title="Priority"
              >
                <option value="high">High</option>
                <option value="medium">Med</option>
                <option value="low">Low</option>
              </select>
              <button
                className="dashboard-add-btn"
                onClick={() => void handleAddTodo()}
                disabled={!todoText.trim()}
                aria-label="Add todo"
              >
                <Plus size={14} />
              </button>
            </div>

            {pendingTodos.length === 0 && doneTodos.length === 0 && (
              <div className="dashboard-empty">No todos yet</div>
            )}

            <ul className="dashboard-todo-list">
              {pendingTodos.map((todo) => (
                <li key={todo.id} className="dashboard-todo-item">
                  <input
                    type="checkbox"
                    checked={false}
                    onChange={() => void handleToggleTodo(todo)}
                    className="dashboard-todo-check"
                    aria-label={`Complete: ${todo.text}`}
                  />
                  <span className="dashboard-todo-text">{todo.text}</span>
                  <button
                    className={`dashboard-priority-badge ${PRIORITY_CLASS[todo.priority]}`}
                    title="Change priority"
                    onClick={() => {
                      const next: Priority = todo.priority === "high" ? "medium" : todo.priority === "medium" ? "low" : "high";
                      void handleChangeTodoPriority(todo, next);
                    }}
                  >
                    {PRIORITY_LABEL[todo.priority]}
                  </button>
                  <button
                    className="dashboard-item-del"
                    onClick={() => void handleDeleteTodo(todo.id)}
                    aria-label="Delete todo"
                  >
                    <Trash2 size={11} />
                  </button>
                </li>
              ))}
            </ul>

            {doneTodos.length > 0 && (
              <>
                <div className="dashboard-section-label">Completed</div>
                <ul className="dashboard-todo-list done">
                  {doneTodos.map((todo) => (
                    <li key={todo.id} className="dashboard-todo-item done">
                      <input
                        type="checkbox"
                        checked={true}
                        onChange={() => void handleToggleTodo(todo)}
                        className="dashboard-todo-check"
                        aria-label={`Uncheck: ${todo.text}`}
                      />
                      <span className="dashboard-todo-text">{todo.text}</span>
                      <button
                        className="dashboard-item-del"
                        onClick={() => void handleDeleteTodo(todo.id)}
                        aria-label="Delete todo"
                      >
                        <Trash2 size={11} />
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        ) : (
          <>
            {/* Add note */}
            <div className="dashboard-note-form">
              <textarea
                ref={noteInputRef}
                className="dashboard-input dashboard-note-input"
                placeholder="Write a note (markdown supported)…"
                value={noteText}
                rows={3}
                onChange={(e) => setNoteText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && e.metaKey) void handleAddNote();
                }}
              />
              <div className="dashboard-note-form-bar">
                <label className="dashboard-pin-toggle">
                  <input
                    type="checkbox"
                    checked={notePinned}
                    onChange={(e) => setNotePinned(e.target.checked)}
                  />
                  Pin
                </label>
                <button
                  className="dashboard-add-btn"
                  onClick={() => void handleAddNote()}
                  disabled={!noteText.trim()}
                >
                  <Plus size={14} /> Add note
                </button>
              </div>
            </div>

            {sortedNotes.length === 0 && (
              <div className="dashboard-empty">No notes yet</div>
            )}

            <div className="dashboard-notes-list">
              {sortedNotes.map((note) => (
                <div key={note.id} className={`dashboard-note-card ${note.pinned ? "pinned" : ""}`}>
                  <div className="dashboard-note-actions">
                    <button
                      className={`dashboard-pin-btn ${note.pinned ? "active" : ""}`}
                      onClick={() => void handleTogglePin(note)}
                      title={note.pinned ? "Unpin" : "Pin"}
                    >
                      {note.pinned ? <PinOff size={11} /> : <Pin size={11} />}
                    </button>
                    <button
                      className="dashboard-item-del"
                      onClick={() => void handleDeleteNote(note.id)}
                      aria-label="Delete note"
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>

                  {editingNoteId === note.id ? (
                    <div className="dashboard-note-edit">
                      <textarea
                        className="dashboard-input dashboard-note-input"
                        value={editingNoteText}
                        rows={4}
                        onChange={(e) => setEditingNoteText(e.target.value)}
                        autoFocus
                      />
                      <div className="dashboard-note-edit-bar">
                        <button className="dashboard-save-btn" onClick={() => void handleSaveNoteEdit(note.id)}>Save</button>
                        <button className="dashboard-cancel-btn" onClick={() => setEditingNoteId(null)}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <div
                      className="dashboard-note-content"
                      onClick={() => { setEditingNoteId(note.id); setEditingNoteText(note.content); }}
                      title="Click to edit"
                    >
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {note.content}
                      </ReactMarkdown>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
