import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: { brand: { 50: "#eef4fa", 100: "#d6e4f2", 500: "#2e6aa3", 600: "#1f4e79", 700: "#173b5c" } },
    },
  },
  plugins: [],
} satisfies Config;
