import React from "react";

type Props = { on: boolean; onChange: () => void };

export function Toggle({ on, onChange }: Props) {
  return (
    <button
      onClick={onChange}
      style={{
        width: 42, height: 23, borderRadius: 99, border: "1px solid var(--line-2)",
        background: on ? "var(--moss)" : "var(--line)", position: "relative",
        cursor: "pointer", padding: 0, transition: "background 0.15s",
      }}
    >
      <span style={{
        position: "absolute", top: 2, left: on ? 21 : 2,
        width: 17, height: 17, borderRadius: 99,
        background: "var(--card)", boxShadow: "0 1px 2px rgba(0,0,0,0.25)",
        transition: "left 0.15s",
      }} />
    </button>
  );
}
