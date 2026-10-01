import { useEffect, useMemo, useRef, useState } from "react";

export interface ModelBlockProps {
  vertices: number[][];
  faces?: number[][];
  colors?: string[];
  color?: string;
  background?: string;
  spin?: boolean;
  wireframe?: boolean;
  title?: string;
  caption?: string;
}

type RGB = [number, number, number];
type Vec3 = [number, number, number];

const DEFAULT_COLOR: RGB = [78, 154, 241]; // #4e9af1

const NAMED_COLORS: Record<string, RGB> = {
  red: [229, 72, 77],
  green: [64, 192, 120],
  blue: [78, 154, 241],
  orange: [241, 167, 78],
  yellow: [241, 232, 78],
  purple: [160, 78, 241],
  pink: [241, 78, 154],
  white: [235, 235, 235],
  black: [40, 40, 40],
  gray: [140, 140, 140],
  grey: [140, 140, 140],
  cyan: [78, 224, 224],
  teal: [78, 200, 200],
};

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

// Parses hex (#rgb / #rrggbb), rgb()/rgba(), or a small set of named colours.
// Returns null on failure so callers can fall back to a default.
function parseColor(c: string | undefined): RGB | null {
  if (!c) return null;
  const s = c.trim().toLowerCase();
  if (NAMED_COLORS[s]) return NAMED_COLORS[s];
  if (s[0] === "#") {
    let h = s.slice(1);
    if (h.length === 3)
      h = h
        .split("")
        .map((x) => x + x)
        .join("");
    if (h.length === 6) {
      const n = parseInt(h, 16);
      if (!Number.isNaN(n)) return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    return null;
  }
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const p = m[1].split(",").map((x) => parseFloat(x));
    if (p.length >= 3 && p.slice(0, 3).every((v) => !Number.isNaN(v))) {
      return [clampByte(p[0]), clampByte(p[1]), clampByte(p[2])];
    }
  }
  return null;
}

interface Geometry {
  verts: Vec3[]; // centred + scaled to unit radius
  tris: Vec3[]; // triangle vertex-index triples
  triFace: number[]; // tris[i] belongs to original face triFace[i]
  faceColor: (faceIndex: number) => RGB;
  pointColor: (vertexIndex: number) => RGB;
  hasFaces: boolean;
}

function buildGeometry(props: ModelBlockProps): Geometry | null {
  const raw = (props.vertices ?? []).filter(
    (v) =>
      Array.isArray(v) &&
      v.length >= 3 &&
      typeof v[0] === "number" &&
      Number.isFinite(v[0]) &&
      typeof v[1] === "number" &&
      Number.isFinite(v[1]) &&
      typeof v[2] === "number" &&
      Number.isFinite(v[2]),
  );
  if (raw.length === 0) return null;

  // Auto-centre and scale into a unit-radius sphere so any input range works.
  let cx = 0,
    cy = 0,
    cz = 0;
  for (const v of raw) {
    cx += v[0];
    cy += v[1];
    cz += v[2];
  }
  cx /= raw.length;
  cy /= raw.length;
  cz /= raw.length;

  let maxR = 0;
  for (const v of raw) {
    const dx = v[0] - cx,
      dy = v[1] - cy,
      dz = v[2] - cz;
    const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (r > maxR) maxR = r;
  }
  const scale = maxR > 0 ? 1 / maxR : 1;
  const verts: Vec3[] = raw.map((v) => [
    (v[0] - cx) * scale,
    (v[1] - cy) * scale,
    (v[2] - cz) * scale,
  ]);

  const tris: Vec3[] = [];
  const triFace: number[] = [];
  const rawFaces = (props.faces ?? []).filter(
    (f) => Array.isArray(f) && f.length >= 3,
  );
  rawFaces.forEach((f, fi) => {
    // Fan-triangulate any polygon into triangles.
    for (let i = 1; i < f.length - 1; i++) {
      const a = f[0],
        b = f[i],
        c = f[i + 1];
      if (
        Number.isInteger(a) &&
        Number.isInteger(b) &&
        Number.isInteger(c) &&
        a >= 0 &&
        b >= 0 &&
        c >= 0 &&
        a < verts.length &&
        b < verts.length &&
        c < verts.length
      ) {
        tris.push([a, b, c]);
        triFace.push(fi);
      }
    }
  });

  const defaultBase = parseColor(props.color) ?? DEFAULT_COLOR;
  const list = props.colors ?? [];
  const pick = (idx: number): RGB => {
    if (list.length === 1) return parseColor(list[0]) ?? defaultBase;
    if (idx < list.length) return parseColor(list[idx]) ?? defaultBase;
    return defaultBase;
  };

  return {
    verts,
    tris,
    triFace,
    faceColor: pick,
    pointColor: pick,
    hasFaces: tris.length > 0,
  };
}

const CAM_DIST = 3.2;
const FOCAL = 3.2;
const SPIN_SPEED = 0.6; // radians / second
const DRAG_SENSITIVITY = 0.01;
const PITCH_LIMIT = 1.45;

export function ModelBlock(props: ModelBlockProps) {
  const { vertices, faces, colors, color, title, caption, background, wireframe, spin } =
    props;
  // Pin to the data fields (stable per tool_use message) rather than the props
  // object, so we don't rebuild geometry / restart the RAF loop every render.
  const geom = useMemo(
    () => buildGeometry({ vertices, faces, colors, color }),
    [vertices, faces, colors, color],
  );

  const [collapsed, setCollapsed] = useState(false);
  const [spinning, setSpinning] = useState(spin !== false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const yawRef = useRef(0.6);
  const pitchRef = useRef(-0.35);
  const spinningRef = useRef(spin !== false);
  const draggingRef = useRef(false);
  const lastPointer = useRef({ x: 0, y: 0 });

  useEffect(() => {
    if (collapsed || !geom) return;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let width = 0;
    let height = 0;
    let dpr = 1;
    const resize = () => {
      dpr = window.devicePixelRatio || 1;
      width = container.clientWidth || 1;
      height = 340;
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);

    // Fixed light direction (upper-right, toward viewer); two-sided so meshes
    // look right regardless of face winding.
    const ll = Math.hypot(-0.4, 0.7, 0.9);
    const light: Vec3 = [-0.4 / ll, 0.7 / ll, 0.9 / ll];

    let raf = 0;
    let last = performance.now();

    const render = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (spinningRef.current && !draggingRef.current) {
        yawRef.current += dt * SPIN_SPEED;
      }

      const yaw = yawRef.current;
      const pitch = pitchRef.current;
      const cosY = Math.cos(yaw),
        sinY = Math.sin(yaw),
        cosX = Math.cos(pitch),
        sinX = Math.sin(pitch);

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      if (background) {
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, width, height);
      }

      const cxs = width / 2;
      const cys = height / 2;
      const viewScale = Math.min(width, height) * 0.42;

      // Rotate (yaw about Y, then pitch about X) into camera space.
      const rot = geom.verts.map(([x, y, z]) => {
        const x1 = x * cosY + z * sinY;
        const z1 = -x * sinY + z * cosY;
        const y2 = y * cosX - z1 * sinX;
        const z2 = y * sinX + z1 * cosX;
        return { x: x1, y: y2, z: z2 };
      });
      // Perspective projection to screen coordinates.
      const proj = rot.map((p) => {
        const s = FOCAL / Math.max(0.1, CAM_DIST - p.z);
        return {
          x: cxs + p.x * s * viewScale,
          y: cys - p.y * s * viewScale,
          z: p.z,
        };
      });

      if (geom.hasFaces) {
        // Painter's algorithm: draw far (small z) triangles first.
        const order = geom.tris.map((t, i) => ({
          i,
          z: (rot[t[0]].z + rot[t[1]].z + rot[t[2]].z) / 3,
        }));
        order.sort((a, b) => a.z - b.z);

        for (const { i } of order) {
          const [a, b, c] = geom.tris[i];
          const ra = rot[a],
            rb = rot[b],
            rc = rot[c];
          // Face normal via cross product of two edges (in camera space).
          const ux = rb.x - ra.x,
            uy = rb.y - ra.y,
            uz = rb.z - ra.z;
          const vx = rc.x - ra.x,
            vy = rc.y - ra.y,
            vz = rc.z - ra.z;
          let nx = uy * vz - uz * vy;
          let ny = uz * vx - ux * vz;
          let nz = ux * vy - uy * vx;
          const nl = Math.hypot(nx, ny, nz) || 1;
          nx /= nl;
          ny /= nl;
          nz /= nl;
          const diffuse = Math.abs(
            nx * light[0] + ny * light[1] + nz * light[2],
          );
          const bright = 0.35 + 0.65 * diffuse;

          const base = geom.faceColor(geom.triFace[i]);
          const r = clampByte(base[0] * bright);
          const g = clampByte(base[1] * bright);
          const bl = clampByte(base[2] * bright);

          const pa = proj[a],
            pb = proj[b],
            pc = proj[c];
          ctx.beginPath();
          ctx.moveTo(pa.x, pa.y);
          ctx.lineTo(pb.x, pb.y);
          ctx.lineTo(pc.x, pc.y);
          ctx.closePath();
          if (wireframe) {
            ctx.strokeStyle = `rgb(${r},${g},${bl})`;
            ctx.lineWidth = 1;
            ctx.stroke();
          } else {
            ctx.fillStyle = `rgb(${r},${g},${bl})`;
            ctx.fill();
            // Faint edge to define adjacent faces.
            ctx.strokeStyle = "rgba(0,0,0,0.14)";
            ctx.lineWidth = 0.5;
            ctx.stroke();
          }
        }
      } else {
        // Point cloud: draw far points first, size by depth.
        const order = proj.map((p, i) => ({ i, z: p.z }));
        order.sort((a, b) => a.z - b.z);
        for (const { i } of order) {
          const p = proj[i];
          const base = geom.pointColor(i);
          const s = FOCAL / Math.max(0.1, CAM_DIST - p.z);
          const rad = Math.max(1.5, 4.5 * s);
          ctx.beginPath();
          ctx.arc(p.x, p.y, rad, 0, Math.PI * 2);
          ctx.fillStyle = `rgb(${base[0]},${base[1]},${base[2]})`;
          ctx.fill();
        }
      }

      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);

    const onPointerDown = (e: PointerEvent) => {
      draggingRef.current = true;
      spinningRef.current = false;
      setSpinning(false);
      lastPointer.current = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!draggingRef.current) return;
      const dx = e.clientX - lastPointer.current.x;
      const dy = e.clientY - lastPointer.current.y;
      lastPointer.current = { x: e.clientX, y: e.clientY };
      yawRef.current += dx * DRAG_SENSITIVITY;
      pitchRef.current = Math.max(
        -PITCH_LIMIT,
        Math.min(PITCH_LIMIT, pitchRef.current + dy * DRAG_SENSITIVITY),
      );
    };
    const onPointerUp = (e: PointerEvent) => {
      draggingRef.current = false;
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {
        // capture may already be released
      }
    };
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
    };
  }, [geom, collapsed, background, wireframe]);

  const toggleSpin = () => {
    const next = !spinningRef.current;
    spinningRef.current = next;
    setSpinning(next);
  };
  const resetView = () => {
    yawRef.current = 0.6;
    pitchRef.current = -0.35;
  };

  return (
    <div className={`model-block${collapsed ? " collapsed" : ""}`}>
      <div
        className="model-block-header"
        onClick={() => setCollapsed((c) => !c)}
        title={collapsed ? "Click to expand" : "Click to collapse"}
      >
        <span className="chevron">{collapsed ? "▸" : "▾"}</span>
        <span className="model-block-title">{title || "3D Model"}</span>
        {!collapsed && geom && (
          <span
            className="model-block-controls"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="model-block-btn"
              onClick={toggleSpin}
              title={spinning ? "Pause rotation" : "Resume rotation"}
            >
              {spinning ? "⏸ Spin" : "▶ Spin"}
            </button>
            <button
              type="button"
              className="model-block-btn"
              onClick={resetView}
              title="Reset view"
            >
              ⟲ Reset
            </button>
          </span>
        )}
      </div>
      {!collapsed && (
        <>
          <div className="model-block-body" ref={containerRef}>
            {geom ? (
              <canvas ref={canvasRef} className="model-block-canvas" />
            ) : (
              <div className="model-block-empty">No geometry to display.</div>
            )}
          </div>
          {caption && <div className="model-block-caption">{caption}</div>}
        </>
      )}
    </div>
  );
}
