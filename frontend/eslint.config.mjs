import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier/flat";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  prettier,
  globalIgnores([".next/**", "node_modules/**", "next-env.d.ts"]),
  {
    // cosmic-ui から取り込んだコンポーネント。zag-js の presence は ref コールバックと
    // `present` を同時に返す設計で、react-hooks/refs が誤検知するため除外する。
    files: ["components/ui/**"],
    rules: { "react-hooks/refs": "off" },
  },
]);
