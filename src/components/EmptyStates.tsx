import { useRef, useCallback } from "react";
import type React from "react";
import { OpenRepoMenu } from "./OpenRepoMenu.js";
import { SetupPanel } from "./SetupPanel.js";
import { RemoteAccessCard } from "./RemoteAccessCard.js";
import type { RecentRepoInfo } from "../types.js";

interface EmptyWorkspaceProps {
  recents: RecentRepoInfo[];
  onOpen: (path: string) => Promise<void>;
  onForgetRecent: (path: string) => void;
}

// Static positions around the logo: [angleDeg, distancePx]
const ORBIT_ICONS: [string, number, number][] = [
  ["typescript",   0,  108],
  ["react",       60,  108],
  ["python",     120,  108],
  ["git",        180,  108],
  ["rust",       240,  108],
  ["go",         300,  108],
];

export function EmptyWorkspace({
  recents,
  onOpen,
  onForgetRecent,
}: EmptyWorkspaceProps) {
  const logoRef = useRef<HTMLDivElement>(null);
  const rafRef  = useRef<number | null>(null);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const tilt = logoRef.current;
      if (!tilt) return;

      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const dx = (e.clientX - vw / 2) / (vw / 2);   // -1 … 1
      const dy = (e.clientY - vh / 2) / (vh / 2);   // -1 … 1

      const rotX = -dy * 20;
      const rotY =  dx * 25;

      // 3D tilt on the inner element — the outer float animation is unaffected
      tilt.style.transform =
        `perspective(400px) rotateX(${rotX}deg) rotateY(${rotY}deg)`;

      // Streaks are only visible inside a ±5° window around rotateY = 0.
      // Outside that window both bars sit off-screen (-120%).
      // Inside the window they sweep from left edge to right edge across those 10°.
      const windowDeg = 10; // total visible window in degrees
      const withinWindow = Math.abs(rotY) < windowDeg / 2;
      const shine = tilt.querySelector<HTMLElement>(".ew-logo-shine");
      if (shine) {
        if (withinWindow) {
          // t goes 0→1 as rotateY goes from -5→+5 deg
          const t = (rotY + windowDeg / 2) / windowDeg;
          const s1 = -15 + t * 130; // wide bar sweeps -15% → 115%
          const s2 = s1 + 12;       // narrow bar 12% behind
          shine.style.setProperty("--s1", `${s1}%`);
          shine.style.setProperty("--s2", `${s2}%`);
        } else {
          shine.style.setProperty("--s1", "-120%");
          shine.style.setProperty("--s2", "-120%");
        }
      }
    });
  }, []);

  const handleMouseLeave = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const tilt = logoRef.current;
    if (!tilt) return;
    tilt.style.transform = "";
    const shine = tilt.querySelector<HTMLElement>(".ew-logo-shine");
    if (shine) {
      shine.style.setProperty("--s1", "-120%");
      shine.style.setProperty("--s2", "-120%");
    }
  }, []);

  return (
    <div
      className="empty-workspace"
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      {/* Ambient glow orbs */}
      <div className="ew-orb ew-orb-primary" aria-hidden="true" />
      <div className="ew-orb ew-orb-secondary" aria-hidden="true" />

      <div className="ew-layout">
        {/* Left column */}
        <SetupPanel />

        {/* Center column — logo / hero */}
        <div className="empty-workspace-card">
          {/* Icon cluster + central logo */}
        <div className="ew-icon-cluster" aria-hidden="true">
          {/* Static language icons at fixed positions */}
          {ORBIT_ICONS.map(([icon, angle, dist]) => {
            const rad = (angle - 90) * (Math.PI / 180);
            const x = Math.cos(rad) * dist;
            const y = Math.sin(rad) * dist;
            return (
              <div
                key={icon}
                className="ew-icon-pin"
                style={{
                  "--pin-x": `${x}px`,
                  "--pin-y": `${y}px`,
                } as React.CSSProperties}
              >
                <img
                  src={`/file-icons/${icon}.svg`}
                  alt=""
                  className="ew-icon"
                  draggable={false}
                />
              </div>
            );
          })}

          {/* Buildover logo — outer floats, inner tilts in 3D */}
          <div className="ew-logo-wrap">
            <div className="ew-logo-tilt" ref={logoRef}>
              <img
                src="/icon.png"
                alt="Buildover"
                className="ew-logo"
                draggable={false}
              />
              {/* Two solid glisten streaks */}
              <div className="ew-logo-shine" aria-hidden="true" />
            </div>
          </div>
        </div>

        {/* Headline + subtitle */}
        <div className="ew-text-block">
          <h2 className="ew-headline">Your codebase, meet Claude</h2>
          <p className="ew-subtext">
            Drop into any project folder and start building with an AI that
            actually reads your code.
          </p>
        </div>

        {/* Open repo CTA */}
        <div className="ew-cta">
          <OpenRepoMenu
            recents={recents}
            openPaths={[]}
            onOpen={onOpen}
            onForgetRecent={onForgetRecent}
          />
        </div>

        {/* Feature hint chips */}
        <div className="ew-chips" aria-label="Features">
          <span className="ew-chip">Any language</span>
          <span className="ew-chip-dot" aria-hidden="true">·</span>
          <span className="ew-chip">Git-aware</span>
          <span className="ew-chip-dot" aria-hidden="true">·</span>
          <span className="ew-chip">Privacy-first</span>
        </div>
      </div>

      {/* Right column */}
      <RemoteAccessCard />
      </div>
    </div>
  );
}

interface EmptyChatProps {
  onCreate: () => void;
}

export function EmptyChat({ onCreate }: EmptyChatProps) {
  return (
    <div className="empty-chat">
      <div className="empty-chat-card">
        <h3>No chat selected</h3>
        <p>Pick a chat from the sidebar, or start a new one.</p>
        <button type="button" className="primary-btn" onClick={onCreate}>
          + New chat
        </button>
      </div>
    </div>
  );
}
