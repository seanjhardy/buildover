import { useState } from "react";

interface Props {
  headers: string[];
  rows: string[][];
  title?: string;
  caption?: string;
}

export function TableBlock({ headers, rows, title, caption }: Props) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className={`table-block${collapsed ? " collapsed" : ""}`}>
      <div
        className="table-block-header"
        onClick={() => setCollapsed((c) => !c)}
        title={collapsed ? "Click to expand" : "Click to collapse"}
      >
        <span className="chevron">{collapsed ? "▸" : "▾"}</span>
        <span className="table-block-title">{title || "Table"}</span>
        {collapsed && (
          <span className="table-block-meta">
            {rows.length} row{rows.length !== 1 ? "s" : ""} &middot;{" "}
            {headers.length} col{headers.length !== 1 ? "s" : ""}
          </span>
        )}
      </div>
      {!collapsed && (
        <>
          <div className="table-block-body">
            <table>
              <thead>
                <tr>
                  {headers.map((h, i) => (
                    <th key={i}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, ri) => (
                  <tr key={ri}>
                    {row.map((cell, ci) => (
                      <td key={ci}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {caption && <div className="table-block-caption">{caption}</div>}
        </>
      )}
    </div>
  );
}
