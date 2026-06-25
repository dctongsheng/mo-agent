import React, { useRef } from "react";
import { Sidebar } from "./Sidebar";
import { useAppState } from "../appState";
import { DeskScreen } from "../screens/DeskScreen";
import { EvolveScreen } from "../screens/EvolveScreen";
import { MemoryScreen } from "../screens/MemoryScreen";
import { DreamScreen } from "../screens/DreamScreen";
import { SkillsScreen } from "../screens/SkillsScreen";
import { SettingsScreen } from "../screens/SettingsScreen";

export function Shell() {
  const { screen } = useAppState();
  const mainRef = useRef<HTMLDivElement>(null);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden", background: "var(--bg)", color: "var(--ink)" }}>
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        <Sidebar />
        <div
          ref={mainRef}
          style={{
            flex: 1, overflowY: "auto",
            backgroundImage: "radial-gradient(var(--dot) 1px, transparent 1px)",
            backgroundSize: "22px 22px",
          }}
        >
          {screen === "home"     && <DeskScreen mainRef={mainRef} />}
          {screen === "evolve"   && <EvolveScreen />}
          {screen === "memory"   && <MemoryScreen />}
          {screen === "dream"    && <DreamScreen />}
          {screen === "skills"   && <SkillsScreen />}
          {screen === "settings" && <SettingsScreen />}
        </div>
      </div>
    </div>
  );
}
