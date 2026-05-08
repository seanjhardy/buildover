import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2, X, Play, Pause } from "lucide-react";
import { api, type ScheduledTask } from "../lib/api.js";
import type { Model, PermissionMode } from "../types.js";

interface Props {
  activeRepoPath: string | null;
  onClose: () => void;
}

// Very lightweight human-readable cron summary.
// Handles the most common patterns; falls back to the raw expression.
function describeCron(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [min, hour, dom, month, dow] = parts;

  if (min === "0" && hour !== "*" && dom === "*" && month === "*") {
    const h = Number(hour);
    const suffix = h >= 12 ? "PM" : "AM";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    if (dow === "*") return `Daily at ${h12}:00 ${suffix}`;
    if (dow === "1-5") return `Weekdays at ${h12}:00 ${suffix}`;
    if (dow === "6,0" || dow === "0,6") return `Weekends at ${h12}:00 ${suffix}`;
  }
  if (min !== "*" && hour === "*") return `Every hour at :${min.padStart(2, "0")}`;
  if (min === "*/15" && hour === "*") return "Every 15 minutes";
  if (min === "*/30" && hour === "*") return "Every 30 minutes";
  if (min === "0" && hour === "*/2") return "Every 2 hours";
  return expr;
}

const MODELS: { id: Model; label: string }[] = [
  { id: "claude-opus-4-7", label: "Opus" },
  { id: "claude-sonnet-4-6", label: "Sonnet" },
  { id: "claude-haiku-4-5", label: "Haiku" },
];

const PERMISSION_MODES: { id: PermissionMode; label: string }[] = [
  { id: "default", label: "Ask" },
  { id: "acceptEdits", label: "Auto-edit" },
  { id: "plan", label: "Plan" },
  { id: "bypassPermissions", label: "Bypass" },
];

const CRON_PRESETS = [
  { label: "Daily 9am", value: "0 9 * * *" },
  { label: "Weekdays 9am", value: "0 9 * * 1-5" },
  { label: "Every hour", value: "0 * * * *" },
  { label: "Every 30 min", value: "*/30 * * * *" },
  { label: "Weekly Mon 9am", value: "0 9 * * 1" },
];

const EMPTY_FORM = {
  label: "",
  cronExpression: "",
  prompt: "",
  model: "claude-sonnet-4-6" as Model,
  permissionMode: "default" as PermissionMode,
  enabled: true,
};

export function SchedulePanel({ activeRepoPath, onClose }: Props) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setError(null);
      setTasks(await api.listSchedules());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleToggle = async (task: ScheduledTask) => {
    try {
      const updated = await api.updateSchedule(task.id, { enabled: !task.enabled });
      setTasks((prev) => prev.map((t) => t.id === task.id ? updated : t));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await api.deleteSchedule(id);
      setTasks((prev) => prev.filter((t) => t.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleCreate = async () => {
    if (!form.cronExpression.trim() || !form.prompt.trim()) {
      setError("Cron expression and prompt are required.");
      return;
    }
    if (!activeRepoPath) {
      setError("No repo is open. Open a repo first.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const task = await api.createSchedule({
        label: form.label.trim() || "Untitled task",
        cronExpression: form.cronExpression.trim(),
        prompt: form.prompt.trim(),
        repoPath: activeRepoPath,
        model: form.model,
        permissionMode: form.permissionMode,
        enabled: form.enabled,
      });
      setTasks((prev) => [...prev, task]);
      setForm({ ...EMPTY_FORM });
      setShowForm(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="schedule-panel">
      <div className="schedule-panel-header">
        <span className="schedule-panel-title">Scheduled Tasks</span>
        <div className="schedule-panel-header-actions">
          <button
            className="schedule-add-btn"
            onClick={() => setShowForm((v) => !v)}
            title="New scheduled task"
          >
            <Plus size={13} />
            New
          </button>
          <button className="dashboard-close" onClick={onClose} aria-label="Close">
            <X size={14} />
          </button>
        </div>
      </div>

      {error && <div className="dashboard-error">{error}</div>}

      {showForm && (
        <div className="schedule-form">
          <div className="schedule-form-row">
            <label className="schedule-form-label">Label</label>
            <input
              className="dashboard-input"
              placeholder="e.g. Daily standup summary"
              value={form.label}
              onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
            />
          </div>

          <div className="schedule-form-row">
            <label className="schedule-form-label">Schedule</label>
            <div className="schedule-cron-row">
              <input
                className="dashboard-input schedule-cron-input"
                placeholder="0 9 * * 1-5"
                value={form.cronExpression}
                onChange={(e) => setForm((f) => ({ ...f, cronExpression: e.target.value }))}
              />
              {form.cronExpression && (
                <span className="schedule-cron-hint">{describeCron(form.cronExpression)}</span>
              )}
            </div>
            <div className="schedule-presets">
              {CRON_PRESETS.map((p) => (
                <button
                  key={p.value}
                  className={`schedule-preset-chip ${form.cronExpression === p.value ? "active" : ""}`}
                  onClick={() => setForm((f) => ({ ...f, cronExpression: p.value }))}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div className="schedule-form-row">
            <label className="schedule-form-label">Prompt</label>
            <textarea
              className="dashboard-input"
              placeholder="What should Claude do when this fires?"
              value={form.prompt}
              rows={3}
              onChange={(e) => setForm((f) => ({ ...f, prompt: e.target.value }))}
            />
          </div>

          <div className="schedule-form-row schedule-form-selects">
            <div>
              <label className="schedule-form-label">Model</label>
              <select
                className="dashboard-input"
                value={form.model}
                onChange={(e) => setForm((f) => ({ ...f, model: e.target.value as Model }))}
              >
                {MODELS.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="schedule-form-label">Mode</label>
              <select
                className="dashboard-input"
                value={form.permissionMode}
                onChange={(e) => setForm((f) => ({ ...f, permissionMode: e.target.value as PermissionMode }))}
              >
                {PERMISSION_MODES.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="schedule-form-actions">
            <button
              className="schedule-save-btn"
              onClick={() => void handleCreate()}
              disabled={saving || !form.cronExpression.trim() || !form.prompt.trim()}
            >
              {saving ? "Saving…" : "Create task"}
            </button>
            <button
              className="dashboard-cancel-btn"
              onClick={() => { setShowForm(false); setError(null); }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="schedule-list">
        {loading && <div className="dashboard-loading">Loading…</div>}
        {!loading && tasks.length === 0 && !showForm && (
          <div className="dashboard-empty">
            No scheduled tasks yet.<br />
            Click <strong>New</strong> to create one.
          </div>
        )}
        {tasks.map((task) => (
          <div key={task.id} className={`schedule-task ${task.enabled ? "enabled" : "disabled"}`}>
            <div className="schedule-task-header">
              <span className="schedule-task-label">{task.label}</span>
              <div className="schedule-task-actions">
                <button
                  className={`schedule-toggle-btn ${task.enabled ? "on" : "off"}`}
                  onClick={() => void handleToggle(task)}
                  title={task.enabled ? "Pause" : "Resume"}
                >
                  {task.enabled ? <Pause size={11} /> : <Play size={11} />}
                </button>
                <button
                  className="dashboard-item-del"
                  onClick={() => void handleDelete(task.id)}
                  aria-label="Delete task"
                >
                  <Trash2 size={11} />
                </button>
              </div>
            </div>
            <div className="schedule-task-cron">
              <span className="schedule-task-expr">{task.cronExpression}</span>
              <span className="schedule-task-desc">{describeCron(task.cronExpression)}</span>
            </div>
            <div className="schedule-task-prompt">{task.prompt.length > 100 ? task.prompt.slice(0, 100) + "…" : task.prompt}</div>
            <div className="schedule-task-meta">
              {task.model.replace("claude-", "").replace("-4-7", " opus").replace("-4-6", " sonnet").replace("-4-5", " haiku")}
              {task.lastRunAt && (
                <span> · Last run {new Date(task.lastRunAt).toLocaleString()}</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
