import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

// Renders a ShowImage call. The server snapshots each image at call time and
// the tool result carries one line per input path, in order; a line that
// displayed its image ends with `[shown:<hash>.<ext>]`, which names the
// snapshot served from /api/shown-images. Lines without a reference are the
// reason that path couldn't be shown.

const SHOWN_IMAGE_REF = /\[shown:([a-f0-9]{32}\.(?:png|jpg|gif|webp|svg))\]/;

interface Props {
  paths: string[];
  caption?: string;
  result?: { content: string; isError: boolean };
}

type Item =
  | { path: string; state: "pending" }
  | { path: string; state: "shown"; src: string }
  | { path: string; state: "failed"; reason: string };

function itemsFor(paths: string[], result: Props["result"]): Item[] {
  if (!result) return paths.map((path) => ({ path, state: "pending" }));
  const lines = result.content.split("\n");
  return paths.map((path, i) => {
    const line = lines[i] ?? "";
    const ref = SHOWN_IMAGE_REF.exec(line)?.[1];
    if (ref) return { path, state: "shown", src: `/api/shown-images/${ref}` };
    const reason = line.replace(/^Could not display .*?: /, "").replace(/\.$/, "");
    return { path, state: "failed", reason: reason || "not displayed" };
  });
}

const fileName = (path: string) => path.split(/[\\/]/).pop() || path;

function Placeholder({ path, reason }: { path: string; reason: string }) {
  return (
    <div className="image-block-placeholder" title={path}>
      <span className="image-block-placeholder-name">{fileName(path)}</span>
      <span>Image unavailable: {reason}</span>
    </div>
  );
}

function Shown({ path, src, onOpen }: { path: string; src: string; onOpen: () => void }) {
  const [broken, setBroken] = useState(false);
  if (broken) return <Placeholder path={path} reason="the saved copy is missing" />;
  return (
    <button type="button" className="image-block-thumb" onClick={onOpen} title={`${path}\nClick to view full size`}>
      <img src={src} alt={fileName(path)} loading="lazy" onError={() => setBroken(true)} />
    </button>
  );
}

function Lightbox({ src, path, onClose }: { src: string; path: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div className="image-lightbox" onClick={onClose} role="dialog" aria-label={fileName(path)}>
      <img src={src} alt={fileName(path)} />
      <div className="image-lightbox-path">{path}</div>
    </div>,
    document.body,
  );
}

export function ImageBlock({ paths, caption, result }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [open, setOpen] = useState<{ src: string; path: string } | null>(null);
  const items = itemsFor(paths, result);
  const title = paths.length === 1 ? fileName(paths[0]) : `${paths.length} images`;

  return (
    <div className={`svg-block image-block${collapsed ? " collapsed" : ""}`}>
      <div
        className="svg-block-header"
        onClick={() => setCollapsed((c) => !c)}
        title={collapsed ? "Click to expand" : "Click to collapse"}
      >
        <span className="chevron">{collapsed ? "▸" : "▾"}</span>
        <span className="svg-block-title">{title}</span>
      </div>
      {!collapsed && (
        <>
          <div className="image-block-body">
            {items.map((item, i) =>
              item.state === "pending" ? (
                <div key={i} className="image-block-placeholder">
                  <span className="image-block-placeholder-name">{fileName(item.path)}</span>
                  <span>Loading…</span>
                </div>
              ) : item.state === "failed" ? (
                <Placeholder key={i} path={item.path} reason={item.reason} />
              ) : (
                <Shown
                  key={i}
                  path={item.path}
                  src={item.src}
                  onOpen={() => setOpen({ src: item.src, path: item.path })}
                />
              ),
            )}
          </div>
          {caption && <div className="svg-block-caption">{caption}</div>}
        </>
      )}
      {open && <Lightbox src={open.src} path={open.path} onClose={() => setOpen(null)} />}
    </div>
  );
}
