import { tokenOf } from "./verdictTokens";
import type { GroupVerdict } from "../../lib/api";

export function VerdictStamp({
  verdict,
  size = "md",
  animateKey,
}: {
  verdict: GroupVerdict;
  size?: "sm" | "md" | "lg";
  animateKey?: string | number;
}) {
  const t = tokenOf(verdict);
  if (!t) return null;
  const sizing =
    size === "lg"
      ? "text-[15px] px-4 py-2"
      : size === "sm"
        ? "text-[10.5px] px-2 py-1"
        : "text-[12px] px-3 py-1.5";
  return (
    <span
      key={animateKey}
      className={`stamp stamp-in ${sizing}`}
      style={{ color: t.color }}
    >
      <span aria-hidden>{t.glyph}</span>
      {t.label}
    </span>
  );
}
