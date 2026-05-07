import { useState } from "react";

export function ThinkingBlock({ thinking }: { thinking: string }) {
  const [collapsed, setCollapsed] = useState(true);
  return (
    <div
      className={`thinking ${collapsed ? "collapsed" : ""}`}
      onClick={() => setCollapsed((c) => !c)}
    >
      <div className="thinking-header">
        <span className="chevron">▾</span>
        Thinking
      </div>
      <div className="thinking-content">{thinking}</div>
    </div>
  );
}
