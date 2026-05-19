import { useState } from "react";

// Default colour palette — chosen for legibility on dark backgrounds.
const PALETTE = [
  "#4e9af1", // blue
  "#f1a74e", // orange
  "#4ef1a1", // mint
  "#f14e9a", // pink
  "#a04ef1", // purple
  "#f1e84e", // yellow
  "#4ef1e0", // teal
  "#f16b4e", // coral
];

export interface ChartDataset {
  label: string;
  values: number[];
  /** Optional CSS colour for this series (e.g. "#4e9af1"). Falls back to palette. */
  color?: string;
}

export interface ChartProps {
  type: "bar" | "line" | "pie";
  labels: string[];
  datasets: ChartDataset[];
  title?: string;
  caption?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function fmt(n: number): string {
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (Math.abs(n) >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/** Round up to the next "nice" number (1/2/5 × 10^n) for y-axis headroom. */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const e = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / e;
  if (f <= 1) return e;
  if (f <= 2) return 2 * e;
  if (f <= 5) return 5 * e;
  return 10 * e;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// ── Bar Chart ──────────────────────────────────────────────────────────────

function BarChart({
  labels,
  datasets,
}: {
  labels: string[];
  datasets: ChartDataset[];
}) {
  const W = 560,
    H = 260;
  const ML = 52,
    MR = 20,
    MT = 16;
  const hasLegend = datasets.length > 1;
  const MB = hasLegend ? 72 : 48;
  const pW = W - ML - MR;
  const pH = H - MT - MB;

  const allVals = datasets.flatMap((d) => d.values);
  const rawMax = Math.max(...allVals, 0);
  const yMax = niceMax(rawMax * 1.05);
  const TICKS = 4;
  const ticks = Array.from({ length: TICKS + 1 }, (_, i) => (yMax * i) / TICKS);

  const G = Math.max(labels.length, 1);
  const D = datasets.length;
  const groupW = pW / G;
  const pad = Math.max(4, groupW * 0.12);
  const totalBarW = groupW - pad * 2;
  const barW = Math.max(4, totalBarW / D - 1);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      xmlns="http://www.w3.org/2000/svg"
      style={{ width: "100%", height: "auto", display: "block" }}
    >
      {/* Gridlines + y-axis labels */}
      {ticks.map((tick, i) => {
        const y = MT + pH - (tick / yMax) * pH;
        return (
          <g key={i}>
            <line
              x1={ML}
              y1={y}
              x2={ML + pW}
              y2={y}
              stroke={
                i === 0
                  ? "rgba(255,255,255,0.15)"
                  : "rgba(255,255,255,0.05)"
              }
              strokeWidth="1"
            />
            <text
              x={ML - 6}
              y={y + 4}
              textAnchor="end"
              fontSize="10"
              fill="rgba(255,255,255,0.4)"
            >
              {fmt(tick)}
            </text>
          </g>
        );
      })}

      {/* Bars */}
      {datasets.map((ds, di) => {
        const color = ds.color ?? PALETTE[di % PALETTE.length];
        return ds.values.map((val, gi) => {
          const barH = Math.max(0, (val / yMax) * pH);
          const x = ML + gi * groupW + pad + di * (barW + 1);
          const y = MT + pH - barH;
          return (
            <rect
              key={`${di}-${gi}`}
              x={x}
              y={y}
              width={barW}
              height={barH}
              fill={color}
              rx="2"
              opacity={0.85}
            />
          );
        });
      })}

      {/* X-axis baseline */}
      <line
        x1={ML}
        y1={MT + pH}
        x2={ML + pW}
        y2={MT + pH}
        stroke="rgba(255,255,255,0.15)"
        strokeWidth="1"
      />

      {/* X labels */}
      {labels.map((label, i) => (
        <text
          key={i}
          x={ML + i * groupW + groupW / 2}
          y={MT + pH + 16}
          textAnchor="middle"
          fontSize="10"
          fill="rgba(255,255,255,0.45)"
        >
          {truncate(label, 14)}
        </text>
      ))}

      {/* Legend */}
      {hasLegend &&
        (() => {
          const legendY = H - 20;
          const itemW = 120;
          const totalW = datasets.length * itemW;
          const startX = ML + (pW - totalW) / 2;
          return datasets.map((ds, i) => {
            const color = ds.color ?? PALETTE[i % PALETTE.length];
            const lx = startX + i * itemW;
            return (
              <g key={i}>
                <rect
                  x={lx}
                  y={legendY - 7}
                  width={10}
                  height={10}
                  fill={color}
                  rx="2"
                />
                <text
                  x={lx + 14}
                  y={legendY + 3}
                  fontSize="10"
                  fill="rgba(255,255,255,0.55)"
                >
                  {truncate(ds.label, 13)}
                </text>
              </g>
            );
          });
        })()}
    </svg>
  );
}

// ── Line Chart ─────────────────────────────────────────────────────────────

function LineChart({
  labels,
  datasets,
}: {
  labels: string[];
  datasets: ChartDataset[];
}) {
  const W = 560,
    H = 260;
  const ML = 52,
    MR = 20,
    MT = 16;
  const hasLegend = datasets.length > 1;
  const MB = hasLegend ? 72 : 48;
  const pW = W - ML - MR;
  const pH = H - MT - MB;

  const allVals = datasets.flatMap((d) => d.values);
  const rawMax = Math.max(...allVals, 0);
  const rawMin = Math.min(...allVals, 0);
  const yMax = niceMax(rawMax * 1.05);
  const yMin = rawMin < 0 ? -niceMax(Math.abs(rawMin) * 1.05) : 0;
  const yRange = yMax - yMin || 1;

  const TICKS = 4;
  const ticks = Array.from(
    { length: TICKS + 1 },
    (_, i) => yMin + (yRange * i) / TICKS,
  );

  const G = labels.length;
  // Space points evenly; for a single point, centre it.
  const xStep = G > 1 ? pW / (G - 1) : 0;
  const xBase = G === 1 ? ML + pW / 2 : ML;

  function xPos(i: number) {
    return xBase + i * xStep;
  }
  function yPos(v: number) {
    return MT + pH - ((v - yMin) / yRange) * pH;
  }

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      xmlns="http://www.w3.org/2000/svg"
      style={{ width: "100%", height: "auto", display: "block" }}
    >
      {/* Gridlines + y-axis labels */}
      {ticks.map((tick, i) => {
        const y = yPos(tick);
        return (
          <g key={i}>
            <line
              x1={ML}
              y1={y}
              x2={ML + pW}
              y2={y}
              stroke={
                tick === 0
                  ? "rgba(255,255,255,0.15)"
                  : "rgba(255,255,255,0.05)"
              }
              strokeWidth="1"
            />
            <text
              x={ML - 6}
              y={y + 4}
              textAnchor="end"
              fontSize="10"
              fill="rgba(255,255,255,0.4)"
            >
              {fmt(tick)}
            </text>
          </g>
        );
      })}

      {/* Lines + dots per dataset */}
      {datasets.map((ds, di) => {
        const color = ds.color ?? PALETTE[di % PALETTE.length];
        const pts = ds.values
          .map((v, i) => `${xPos(i)},${yPos(v)}`)
          .join(" ");
        return (
          <g key={di}>
            {G > 1 && (
              <polyline
                points={pts}
                fill="none"
                stroke={color}
                strokeWidth="2"
                strokeLinejoin="round"
                opacity={0.85}
              />
            )}
            {ds.values.map((v, i) => (
              <circle
                key={i}
                cx={xPos(i)}
                cy={yPos(v)}
                r={3}
                fill={color}
                opacity={0.9}
              />
            ))}
          </g>
        );
      })}

      {/* X-axis baseline */}
      <line
        x1={ML}
        y1={MT + pH}
        x2={ML + pW}
        y2={MT + pH}
        stroke="rgba(255,255,255,0.15)"
        strokeWidth="1"
      />

      {/* X labels */}
      {labels.map((label, i) => (
        <text
          key={i}
          x={xPos(i)}
          y={MT + pH + 16}
          textAnchor="middle"
          fontSize="10"
          fill="rgba(255,255,255,0.45)"
        >
          {truncate(label, 14)}
        </text>
      ))}

      {/* Legend */}
      {hasLegend &&
        (() => {
          const legendY = H - 20;
          const itemW = 120;
          const totalW = datasets.length * itemW;
          const startX = ML + (pW - totalW) / 2;
          return datasets.map((ds, i) => {
            const color = ds.color ?? PALETTE[i % PALETTE.length];
            const lx = startX + i * itemW;
            return (
              <g key={i}>
                <line
                  x1={lx}
                  y1={legendY - 2}
                  x2={lx + 10}
                  y2={legendY - 2}
                  stroke={color}
                  strokeWidth="2"
                />
                <circle cx={lx + 5} cy={legendY - 2} r={3} fill={color} />
                <text
                  x={lx + 14}
                  y={legendY + 3}
                  fontSize="10"
                  fill="rgba(255,255,255,0.55)"
                >
                  {truncate(ds.label, 13)}
                </text>
              </g>
            );
          });
        })()}
    </svg>
  );
}

// ── Pie Chart ──────────────────────────────────────────────────────────────

function polarToXY(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = (angleDeg - 90) * (Math.PI / 180);
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function arcPath(
  cx: number,
  cy: number,
  r: number,
  startAngle: number,
  endAngle: number,
): string {
  // Full circle needs two arcs (SVG can't draw a 360° arc in one command).
  if (endAngle - startAngle >= 359.99) {
    const top = polarToXY(cx, cy, r, 0);
    const bot = polarToXY(cx, cy, r, 180);
    return (
      `M ${top.x} ${top.y} A ${r} ${r} 0 1 1 ${bot.x} ${bot.y} ` +
      `A ${r} ${r} 0 1 1 ${top.x} ${top.y} Z`
    );
  }
  const start = polarToXY(cx, cy, r, startAngle);
  const end = polarToXY(cx, cy, r, endAngle);
  const large = endAngle - startAngle > 180 ? 1 : 0;
  return `M ${cx} ${cy} L ${start.x} ${start.y} A ${r} ${r} 0 ${large} 1 ${end.x} ${end.y} Z`;
}

function PieChart({
  labels,
  datasets,
}: {
  labels: string[];
  datasets: ChartDataset[];
}) {
  const W = 480,
    H = 260;
  const cx = 130,
    cy = 128,
    r = 108;
  const legendX = 258;

  // Pie charts show a single series; use first dataset's values.
  const values = datasets[0]?.values ?? [];
  const total = values.reduce((a, b) => a + b, 0);

  if (total === 0) {
    return (
      <svg
        viewBox={`0 0 ${W} ${H}`}
        xmlns="http://www.w3.org/2000/svg"
        style={{ width: "100%", height: "auto", display: "block" }}
      >
        <text
          x={W / 2}
          y={H / 2}
          textAnchor="middle"
          fontSize="12"
          fill="rgba(255,255,255,0.3)"
        >
          No data
        </text>
      </svg>
    );
  }

  let angle = 0;
  const slices = values.map((v, i) => {
    const sweep = (v / total) * 360;
    const slice = {
      startAngle: angle,
      endAngle: angle + sweep,
      label: labels[i] ?? `Item ${i + 1}`,
      pct: (v / total) * 100,
      color: PALETTE[i % PALETTE.length],
    };
    angle += sweep;
    return slice;
  });

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      xmlns="http://www.w3.org/2000/svg"
      style={{ width: "100%", height: "auto", display: "block" }}
    >
      {/* Slices */}
      {slices.map((s, i) => (
        <path
          key={i}
          d={arcPath(cx, cy, r, s.startAngle, s.endAngle)}
          fill={s.color}
          stroke="#1e1e1e"
          strokeWidth="1.5"
          opacity={0.88}
        />
      ))}

      {/* Legend */}
      {slices.map((s, i) => {
        const ly = 28 + i * 22;
        return (
          <g key={i}>
            <rect
              x={legendX}
              y={ly - 8}
              width={10}
              height={10}
              fill={s.color}
              rx="2"
            />
            <text
              x={legendX + 14}
              y={ly + 2}
              fontSize="10"
              fill="rgba(255,255,255,0.55)"
            >
              {truncate(s.label, 18)}
            </text>
            <text
              x={W - 8}
              y={ly + 2}
              fontSize="10"
              fill="rgba(255,255,255,0.35)"
              textAnchor="end"
            >
              {s.pct.toFixed(1)}%
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ── Public component ───────────────────────────────────────────────────────

export function ChartBlock({
  type,
  labels,
  datasets,
  title,
  caption,
}: ChartProps) {
  const [collapsed, setCollapsed] = useState(false);

  const typeLabel = type.charAt(0).toUpperCase() + type.slice(1);
  const defaultTitle = title || `${typeLabel} Chart`;

  function renderChart() {
    switch (type) {
      case "bar":
        return <BarChart labels={labels} datasets={datasets} />;
      case "line":
        return <LineChart labels={labels} datasets={datasets} />;
      case "pie":
        return <PieChart labels={labels} datasets={datasets} />;
    }
  }

  return (
    <div className={`chart-block${collapsed ? " collapsed" : ""}`}>
      <div
        className="chart-block-header"
        onClick={() => setCollapsed((c) => !c)}
        title={collapsed ? "Click to expand" : "Click to collapse"}
      >
        <span className="chevron">{collapsed ? "▸" : "▾"}</span>
        <span className="chart-block-title">{defaultTitle}</span>
        <span className="chart-block-type">{type}</span>
      </div>
      {!collapsed && (
        <>
          <div className="chart-block-body">{renderChart()}</div>
          {caption && <div className="chart-block-caption">{caption}</div>}
        </>
      )}
    </div>
  );
}
