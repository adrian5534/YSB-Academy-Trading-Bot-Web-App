import type { Config } from "tailwindcss";

export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ysbPurple: "#6F2898",
        ysbYellow: "#f3ec4e",
        background: "hsl(222 47% 11%)",
        foreground: "hsl(210 40% 98%)",
        card: "hsl(222 47% 13%)",
        border: "hsl(217 33% 17%)",
        muted: "hsl(217 33% 17%)",
        "muted-foreground": "hsl(215 20% 65%)",
      },
      fontFamily: {
        mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
        sans: ["Inter", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
      },
    },
  },
  plugins: [],
} satisfies Config;
