/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        display: ['"JetBrains Mono"', '"IBM Plex Mono"', "ui-monospace", "monospace"],
        mono: ['"JetBrains Mono"', '"IBM Plex Mono"', "ui-monospace", "monospace"],
        sans: ['"Geist"', '"IBM Plex Sans"', "system-ui", "sans-serif"],
      },
      colors: {
        /*
         * Dracula-inspired palette tuned for programmer tooling.
         * - bg scale: void / deep / panel / raised / grid / line
         * - fg scale: bright / base / dim / faint (faint = comment color)
         * - semantic tokens keep original names so callers don't change:
         *   phos = primary brand (purple), amber = warning/rework (orange),
         *   data = info/discuss (cyan), ok = approve (green), anom = reject (red)
         */
        bg: {
          void: "#191a21",
          deep: "#1e1f29",
          panel: "#282a36",
          raised: "#343746",
          grid: "#3a3d4e",
          line: "#44475a",
        },
        fg: {
          bright: "#f8f8f2",
          base: "#e2e2e6",
          dim: "#a9b0c4",
          faint: "#6272a4",
        },
        phos: {
          DEFAULT: "#bd93f9",
          bright: "#d4b8ff",
          dim: "#7042a8",
          glow: "rgba(189, 147, 249, 0.22)",
        },
        amber: {
          DEFAULT: "#ffb86c",
          bright: "#ffd19a",
          dim: "#8a5a2b",
        },
        anom: {
          DEFAULT: "#ff5555",
          bright: "#ff8080",
          dim: "#a03a3a",
        },
        data: {
          DEFAULT: "#8be9fd",
          bright: "#b0f3ff",
          dim: "#4f8998",
        },
        ok: {
          DEFAULT: "#50fa7b",
          bright: "#85ffa5",
          dim: "#2f9547",
        },
        pink: {
          DEFAULT: "#ff79c6",
          dim: "#a9457f",
        },
        yellow: {
          DEFAULT: "#f1fa8c",
          dim: "#90975a",
        },
      },
      boxShadow: {
        phos: "0 0 0 1px rgba(189, 147, 249, 0.35), 0 8px 24px -12px rgba(189, 147, 249, 0.5)",
        soft: "0 1px 0 rgba(0, 0, 0, 0.35), 0 14px 32px -18px rgba(0, 0, 0, 0.5)",
        inset: "inset 0 1px 0 rgba(255, 255, 255, 0.04)",
      },
      letterSpacing: {
        wide2: "0.12em",
        wide3: "0.18em",
      },
      borderRadius: {
        sm: "4px",
        DEFAULT: "6px",
        md: "8px",
      },
    },
  },
};
