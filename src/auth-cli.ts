/**
 * Standalone auth script.
 * Run: npm run auth
 *
 * Chạy 2 lần consent riêng biệt:
 * 1. ACCOUNT GOOGLE DRIVE — đăng nhập bằng account sở hữu folder Drive
 * 2. ACCOUNT YOUTUBE — đăng nhập bằng account sở hữu YouTube channel
 * (Hai account có thể khác nhau)
 *
 * Tokens được lưu: data/drive-token.json + data/youtube-token.json
 */
import { loadConfig } from "./config.js";
import { authenticate } from "./auth.js";

async function main(): Promise<void> {
  const config = loadConfig();

  console.log("🔐 Google OAuth2 Authorization\n");
  console.log("Sẽ có 2 bước đăng nhập:");
  console.log("  1. ACCOUNT GOOGLE DRIVE  → đọc file video trong folder");
  console.log("  2. ACCOUNT YOUTUBE       → upload video lên channel của account này");
  console.log("(Nếu cùng 1 account thì đăng nhập cùng account cho cả 2 bước)\n");

  console.log("══════ BƯỚC 1/2: GOOGLE DRIVE ══════");
  const driveAuth = await authenticate(config, "drive");

  console.log("\n══════ BƯỚC 2/2: YOUTUBE ══════");
  const youtubeAuth = await authenticate(config, "youtube");

  console.log("\n✅ Authorization hoàn tất!");
  console.log(`   Drive tokens   → ${config.driveTokenPath}`);
  console.log(`   YouTube tokens → ${config.youtubeTokenPath}`);
  console.log("   Chạy: npm start");
}

main().catch((err) => {
  console.error("\n❌ Authorization failed:", err);
  process.exit(1);
});