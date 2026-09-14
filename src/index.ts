import { loadConfig } from "./config.js";
import { authenticate } from "./auth.js";
import { startPoller, pollOnceAndExit } from "./poller.js";

async function main(): Promise<void> {
  const isSingleRun = process.argv.includes("--once");

  console.log("🚀 GG2YT — Google Drive → YouTube Auto-Upload\n");

  const config = loadConfig();

  // Drive account và YouTube account có thể là 2 tài khoản khác nhau
  const driveAuth = await authenticate(config, "drive");
  const youtubeAuth = await authenticate(config, "youtube");

  if (isSingleRun) {
    await pollOnceAndExit(driveAuth, youtubeAuth, config);
    console.log("\n✅ Single poll complete.");
  } else {
    console.log("   Mode: Continuous polling");
    console.log("   Press Ctrl+C to stop.\n");

    await startPoller(driveAuth, youtubeAuth, config);
    console.log("\n👋 Shutting down...");
  }
}

main().catch((err) => {
  console.error("\n💥 Fatal error:", err);
  process.exit(1);
});