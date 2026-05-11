import { useState } from "react";
import type { FileEntry } from "../hooks/useFilesChanged.js";

// ---------------------------------------------------------------------------
// Tree data structure
// ---------------------------------------------------------------------------

interface DirNode {
  kind: "dir";
  /** Display label — may be a collapsed path like "src/components" */
  label: string;
  children: TreeNode[];
}

interface FileNode {
  kind: "file";
  name: string;
  entry: FileEntry;
}

type TreeNode = DirNode | FileNode;

function insertEntry(root: DirNode, parts: string[], entry: FileEntry): void {
  if (parts.length === 1) {
    root.children.push({ kind: "file", name: parts[0]!, entry });
    return;
  }
  const dirName = parts[0]!;
  let dir = root.children.find(
    (c): c is DirNode => c.kind === "dir" && c.label === dirName,
  );
  if (!dir) {
    dir = { kind: "dir", label: dirName, children: [] };
    root.children.push(dir);
  }
  insertEntry(dir, parts.slice(1), entry);
}

/** Collapse dirs that contain only one child dir (like VS Code). */
function collapseSingletons(node: DirNode): DirNode {
  const collapsedChildren = node.children.map((c) =>
    c.kind === "dir" ? collapseSingletons(c) : c,
  );
  // If this dir has exactly one child which is itself a dir, merge labels
  if (
    collapsedChildren.length === 1 &&
    collapsedChildren[0]!.kind === "dir"
  ) {
    const only = collapsedChildren[0] as DirNode;
    return {
      kind: "dir",
      label: node.label === "" ? only.label : `${node.label}/${only.label}`,
      children: only.children,
    };
  }
  return { ...node, children: collapsedChildren };
}

function buildTree(entries: FileEntry[]): TreeNode[] {
  const root: DirNode = { kind: "dir", label: "", children: [] };
  for (const entry of entries) {
    const parts = entry.relPath.split("/").filter(Boolean);
    insertEntry(root, parts, entry);
  }
  // Sort: dirs first, then files, alphabetically within each group
  function sortChildren(children: TreeNode[]): TreeNode[] {
    return [...children].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      const aLabel = a.kind === "dir" ? a.label : a.name;
      const bLabel = b.kind === "dir" ? b.label : b.name;
      return aLabel.localeCompare(bLabel);
    });
  }
  function sortTree(nodes: TreeNode[]): TreeNode[] {
    return sortChildren(nodes).map((n) =>
      n.kind === "dir" ? { ...n, children: sortTree(n.children) } : n,
    );
  }
  const collapsed = collapseSingletons(root);
  return sortTree(collapsed.children);
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function StatBadge({ added, removed }: { added?: number; removed?: number }) {
  return (
    <span className="files-stats">
      {(added ?? 0) > 0 && (
        <span className="files-stat-added">+{added}</span>
      )}
      {(removed ?? 0) > 0 && (
        <span className="files-stat-removed">-{removed}</span>
      )}
    </span>
  );
}

function FileNodeRow({ node }: { node: FileNode }) {
  return (
    <div className="files-tree-file">
      <span className="files-tree-icon">◦</span>
      <span className="files-tree-name" title={node.entry.relPath}>
        {node.name}
      </span>
      <StatBadge added={node.entry.added} removed={node.entry.removed} />
    </div>
  );
}

function DirNodeRow({ node, depth }: { node: DirNode; depth: number }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="files-tree-dir-group">
      <div
        className="files-tree-dir"
        onClick={() => setOpen((v) => !v)}
        style={{ paddingLeft: depth * 8 }}
      >
        <span className="files-tree-chevron">{open ? "▾" : "▸"}</span>
        <span className="files-tree-dir-name">{node.label}</span>
      </div>
      {open && (
        <div className="files-tree-children" style={{ paddingLeft: 8 }}>
          {node.children.map((child, i) =>
            child.kind === "dir" ? (
              <DirNodeRow key={i} node={child} depth={depth + 1} />
            ) : (
              <FileNodeRow key={i} node={child} />
            ),
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

interface Props {
  files: FileEntry[];
}

export function FilesPanel({ files }: Props) {
  const [collapsed, setCollapsed] = useState(false);

  if (files.length === 0) return null;

  const tree = buildTree(files);
  const totalAdded = files.reduce((s, f) => s + (f.added ?? 0), 0);
  const totalRemoved = files.reduce((s, f) => s + (f.removed ?? 0), 0);

  return (
    <div className="files-panel">
      <div
        className="files-panel-header"
        onClick={() => setCollapsed((v) => !v)}
        title={collapsed ? "Expand files" : "Collapse files"}
      >
        <span>Files</span>
        <span className="files-panel-header-right">
          {collapsed ? (
            <span className="files-panel-count">{files.length}</span>
          ) : (
            <StatBadge added={totalAdded} removed={totalRemoved} />
          )}
          <span className="files-panel-chevron">{collapsed ? "▸" : "▾"}</span>
        </span>
      </div>
      {!collapsed && (
        <div className="files-tree">
          {tree.map((node, i) =>
            node.kind === "dir" ? (
              <DirNodeRow key={i} node={node} depth={0} />
            ) : (
              <FileNodeRow key={i} node={node} />
            ),
          )}
        </div>
      )}
    </div>
  );
}
