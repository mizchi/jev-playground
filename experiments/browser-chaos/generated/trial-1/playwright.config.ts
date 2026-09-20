// GENERATED. Points Playwright at the browser this environment has.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  timeout: 30_000,
  reporter: "line",
  use: {
    launchOptions: {
      args: ["--no-sandbox"],
      executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    },
  },
});
