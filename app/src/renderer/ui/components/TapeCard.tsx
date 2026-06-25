import React from "react";

type Props = {
  children: React.ReactNode;
  tapeLeft?: boolean;
  tapeRotate?: string;
  style?: React.CSSProperties;
};

export function TapeCard({ children, tapeLeft = true, tapeRotate = "-2.5deg", style }: Props) {
  return (
    <div style={{
      position: "relative", background: "var(--card)", border: "1px solid var(--line)",
      borderRadius: 4, boxShadow: "var(--shadow)", ...style,
    }}>
      <div style={{
        position: "absolute", top: -9, [tapeLeft ? "left" : "right"]: tapeLeft ? 28 : 28,
        width: 52, height: 16, background: "var(--tape)",
        transform: `rotate(${tapeRotate})`,
      }} />
      {children}
    </div>
  );
}
