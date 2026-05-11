import type { AgentTodo } from "../hooks/useTodos.js";

interface Props {
  todos: AgentTodo[];
  /** When true, renders as a narrow icon strip (same style as the jump bar) */
  compact?: boolean;
}

function todoIcon(status: AgentTodo["status"]): string {
  if (status === "in_progress") return "★";
  if (status === "completed") return "☑";
  return "☐";
}

/** Full card — shown when there is enough horizontal space */
function FullPanel({ todos }: { todos: AgentTodo[] }) {
  return (
    <div className="todo-panel">
      <div className="todo-panel-header">Tasks</div>
      <div className="todo-panel-list">
        {todos.map((todo, i) => (
          <div key={i} className={`todo-item todo-item--${todo.status}`}>
            <span className={`todo-icon todo-icon--${todo.status === "in_progress" ? "in-progress" : todo.status}`}>
              {todoIcon(todo.status)}
            </span>
            <span className="todo-item-text">
              {todo.status === "in_progress" ? todo.activeForm : todo.content}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Icon strip — shown when the window is narrow; sits in the right-rail beside the jump bar */
function IconStrip({ todos }: { todos: AgentTodo[] }) {
  return (
    <div className="todo-icon-strip">
      {todos.map((todo, i) => (
        <div key={i} className={`todo-strip-item todo-strip-item--${todo.status}`}>
          <span className="todo-strip-icon">{todoIcon(todo.status)}</span>
          <div className="todo-strip-tooltip">
            {todo.status === "in_progress" ? todo.activeForm : todo.content}
          </div>
        </div>
      ))}
    </div>
  );
}

export function TodoPanel({ todos, compact }: Props) {
  if (todos.length === 0) return null;
  if (todos.every((t) => t.status === "completed")) return null;
  return compact ? <IconStrip todos={todos} /> : <FullPanel todos={todos} />;
}
