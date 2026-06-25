import React from "react";

type Props = { count: number };

export function GrowthRings({ count }: Props) {
  const rings = [
    { r: 18, sw: 1.4, dash: "" },
    { r: 28, sw: 1.2, dash: "3 4" },
    { r: 37, sw: 1.4, dash: "" },
    { r: 47, sw: 1.2, dash: "2 5" },
    { r: 56, sw: 1.4, dash: "" },
    { r: 65, sw: 1.2, dash: "4 4" },
    { r: 74, sw: 1.4, dash: "" },
    { r: 83, sw: 1.2, dash: "2 6" },
    { r: 91, sw: 1.4, dash: "" },
    { r: 98, sw: 1.2, dash: "3 5" },
    { r: 105, sw: 1.4, dash: "" },
    { r: 112, sw: 2.4, dash: "10 5", active: true },
  ];

  // Chinese number characters for display
  const cnNums = ["〇","一","二","三","四","五","六","七","八","九","十","十一","十二","十三","十四","十五"];
  const label = count >= 10 ? "拾" + (count > 10 ? cnNums[count - 10] : "") : cnNums[count] ?? String(count);

  return (
    <svg width="230" height="230" viewBox="0 0 230 230" style={{ display: "block" }}>
      {rings.map((ring, i) => (
        <circle
          key={i}
          cx="115" cy="115" r={ring.r}
          fill="none"
          stroke={ring.active ? "var(--seal)" : "var(--line-2)"}
          strokeWidth={ring.sw}
          strokeDasharray={ring.dash || undefined}
        />
      ))}
      <text
        x="115" y="123" textAnchor="middle"
        fontFamily="'Noto Serif SC', serif" fontSize="22" fontWeight="650"
        fill="var(--ink)"
      >
        {count === 12 ? "拾贰" : label}
      </text>
    </svg>
  );
}
