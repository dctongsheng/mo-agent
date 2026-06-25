import React from "react";

export type DollForm = 0 | 1 | 2;

const DOLL_DATA = [
  {
    name: "小貘", tag: "TAPIR · 食梦",
    body: "M 24 56 C 18 34 38 24 58 23 C 74 22 84 27 90 33 C 96 30 104 30 107 35 C 110 40 105 45 98 45 C 95 45 92 44 90 43 C 91 55 84 63 72 66 C 56 70 36 70 28 63 C 25 60 24 58 24 56",
    extra: ["M 38 68 L 38 80", "M 52 69 L 52 81", "M 68 67 L 68 79", "M 80 64 L 80 76", "M 60 22 C 58 14 66 13 67 20"],
    eyes: [[81, 36]] as [number, number][],
  },
  {
    name: "小猫", tag: "CAT · 守夜",
    body: "M 30 72 C 22 52 26 38 36 32 L 38 20 L 48 29 C 55 26 63 26 70 29 L 80 20 L 82 32 C 92 38 96 52 88 72 C 72 78 46 78 30 72",
    extra: ["M 88 66 C 102 62 104 50 96 44", "M 28 52 L 18 50", "M 28 58 L 18 60", "M 90 52 L 100 50"],
    eyes: [[48, 47], [70, 47]] as [number, number][],
  },
  {
    name: "小鸟", tag: "BIRD · 报晓",
    body: "M 46 76 C 28 72 22 56 26 42 C 30 28 46 22 58 26 C 68 29 72 38 72 46 L 84 50 L 72 56 C 70 68 60 76 46 76",
    extra: ["M 48 24 C 47 17 54 16 54 22", "M 44 76 L 44 86", "M 56 75 L 56 85"],
    eyes: [[58, 38]] as [number, number][],
  },
];

type Props = { form: DollForm; sleeping?: boolean; size?: number };

export function Doll({ form, sleeping = false, size = 168 }: Props) {
  const d = DOLL_DATA[form];
  const h = Math.round(size * (100 / 168));

  return (
    <div style={{ position: "relative" }}>
      <div style={{
        animation: `breathe ${sleeping ? "5s" : "3.4s"} ease-in-out infinite`,
        transformOrigin: "50% 100%",
      }}>
        <svg viewBox="0 0 120 100" width={size} height={h} style={{ display: "block", color: "var(--ink)" }}>
          <path d={d.body} fill="none" stroke="currentColor" strokeWidth={3.2} strokeLinecap="round" strokeLinejoin="round" />
          {d.extra.map((p, i) => (
            <path key={i} d={p} fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" />
          ))}
          {d.eyes.map((e, i) =>
            sleeping ? (
              <path
                key={i}
                d={`M ${e[0] - 3.5} ${e[1]} Q ${e[0]} ${e[1] + 3.5} ${e[0] + 3.5} ${e[1]}`}
                fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round"
              />
            ) : (
              <circle key={i} cx={e[0]} cy={e[1]} r={2.3} fill="currentColor" />
            )
          )}
        </svg>
      </div>
      {sleeping && [0, 1, 2].map((i) => (
        <span key={i} style={{
          position: "absolute", top: 14 - i * 4, right: 28 - i * 10,
          fontFamily: "'Noto Serif SC', serif", fontSize: 15 + i * 3,
          color: "var(--moon)",
          animation: `floatZ 3.6s ease-out ${i * 1.2}s infinite`,
          opacity: 0,
        }}>z</span>
      ))}
    </div>
  );
}

export function getDollMeta(form: DollForm) {
  return { name: DOLL_DATA[form].name, tag: DOLL_DATA[form].tag };
}
