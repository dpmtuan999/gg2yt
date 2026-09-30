import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { createServer, type Server } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import open from "open";
import type { Config } from "./config.js";

/** Loại tài khoản Google cần xác thực */
export type AuthTarget = "drive" | "youtube";

const DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive.readonly"];
const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.force-ssl",
];

function scopesFor(target: AuthTarget): string[] {
  return target === "drive" ? DRIVE_SCOPES : YOUTUBE_SCOPES;
}

function labelFor(target: AuthTarget): string {
  return target === "drive" ? "Google Drive" : "YouTube";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Trích mã lỗi thật từ Google OAuth (vd. `invalid_grant` khi refresh token đã
 * bị revoke). Không có bước này thì log chỉ ghi "token không hợp lệ" — CI fail
 * mà không ai biết nguyên nhân.
 */
function describeOAuthFailure(err: unknown): string {
  if (isRecord(err) && isRecord(err.response) && isRecord(err.response.data)) {
    const { error, error_description: description } = err.response.data;
    if (typeof error === "string") {
      return typeof description === "string"
        ? `${error} — ${description}`
        : error;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

/** Lỗi CI có kèm nguyên nhân cụ thể + tên secret cần cập nhật. */
function ciAuthFailure(target: AuthTarget, label: string, reason: string): Error {
  const secret =
    target === "drive" ? "GG2YT_DRIVE_TOKEN_B64" : "GG2YT_YOUTUBE_TOKEN_B64";
  return new Error(
    `Không thể re-authorize ${label} trong CI: ${reason}.\n` +
      'Chạy "npm run auth" trên máy local để lấy token mới, sau đó cập nhật secret ' +
      `${secret} trên GitHub.`,
  );
}

function tokenPathFor(config: Config, target: AuthTarget): string {
  return target === "drive" ? config.driveTokenPath : config.youtubeTokenPath;
}

interface StoredTokens {
  access_token?: string | null;
  refresh_token?: string | null;
  scope?: string;
  expiry_date?: number | null;
  token_type?: string | null;
}

function loadTokens(tokenPath: string): StoredTokens | null {
  if (!existsSync(tokenPath)) return null;
  try {
    return JSON.parse(readFileSync(tokenPath, "utf-8")) as StoredTokens;
  } catch {
    return null;
  }
}

function saveTokens(tokenPath: string, tokens: StoredTokens): void {
  const dir = dirname(tokenPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(tokenPath, JSON.stringify(tokens, null, 2), "utf-8");
}

function authorizeViaBrowser(
  config: Config,
  credentials: { client_id: string; client_secret: string },
  target: AuthTarget,
): Promise<OAuth2Client> {
  return new Promise((resolve, reject) => {
    const { client_id, client_secret } = credentials;
    // Google chấp nhận loopback localhost với bất kỳ port nào cho OAuth client
    // loại Desktop app. Dùng port cố định để server và redirect khớp nhau.
    const redirectUri = `http://localhost:${config.oauthPort}`;
    const label = labelFor(target);

    const oauth2Client = new google.auth.OAuth2(
      client_id,
      client_secret,
      redirectUri,
    );

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: "offline",
      scope: scopesFor(target),
      prompt: "consent",
    });

    console.log(`\n🔐 Authorization cho tài khoản ${label}...`);
    console.log(`   👉 ĐĂNG NHẬP BẰNG ĐÚNG ACCOUNT ${label.toUpperCase()}`);
    console.log(`   If browser doesn't open, visit:\n   ${authUrl}\n`);

    const server: Server = createServer(async (req, res) => {
      const url = new URL(req.url!, `http://localhost:${config.oauthPort}`);

      // Desktop clients may get redirected to "/" — accept the code from any path.
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      if (code || error) {

        if (error) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(
            `<h2>Authorization failed: ${error}</h2><p>You can close this tab.</p>`,
          );
          server.close();
          reject(new Error(`OAuth2 error: ${error}`));
          return;
        }

        if (!code) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(
            "<h2>No authorization code received</h2><p>You can close this tab.</p>",
          );
          server.close();
          reject(new Error("No authorization code received"));
          return;
        }

        try {
          const { tokens } = await oauth2Client.getToken(code);
          oauth2Client.setCredentials(tokens);

          saveTokens(tokenPathFor(config, target), {
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            scope: tokens.scope,
            expiry_date: tokens.expiry_date,
            token_type: tokens.token_type,
          });

          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(`
            <html><body style="font-family:system-ui;text-align:center;padding:50px">
              <h2>✅ ${label} authorized!</h2>
              <p>You can close this tab.</p>
            </body></html>
          `);

          console.log(`✅ Authorization ${label} thành công!`);
          server.close();
          resolve(oauth2Client);
        } catch (err) {
          res.writeHead(500, { "Content-Type": "text/html" });
          res.end("<h2>Token exchange failed</h2><p>You can close this tab.</p>");
          server.close();
          reject(err);
        }
      } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
      }
    });

    server.listen(config.oauthPort, () => {
      open(authUrl, { wait: false }).catch(() => {
        console.log("   (Could not open browser automatically)");
      });
    });

    server.on("error", (err) => {
      reject(new Error(`OAuth server error: ${err.message}`));
    });
  });
}

/**
 * Xác thực với Google cho một loại tài khoản cụ thể.
 *
 * - target "drive"   → token riêng cho account sở hữu folder Drive
 * - target "youtube" → token riêng cho account sở hữu YouTube channel
 *
 * Hai account KHÔNG cần giống nhau — mỗi cái có token file riêng.
 */
export async function authenticate(
  config: Config,
  target: AuthTarget,
): Promise<OAuth2Client> {
  if (!existsSync(config.credentialsPath)) {
    throw new Error(
      `credentials.json not found at ${config.credentialsPath}\n` +
        "Follow the setup guide to create it:\n" +
        "1. Go to https://console.cloud.google.com/apis/credentials\n" +
        "2. Create OAuth 2.0 Client ID (Desktop app)\n" +
        "3. Download JSON and save as credentials/credentials.json",
    );
  }

  const raw = JSON.parse(readFileSync(config.credentialsPath, "utf-8"));
  const credentials = raw.installed || raw.web;
  if (!credentials) {
    throw new Error(
      "Invalid credentials.json — must contain 'installed' or 'web' key",
    );
  }

  const { client_id, client_secret } = credentials;
  const redirectUri = `http://localhost:${config.oauthPort}`;
  const oauth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirectUri,
  );
  const tokenPath = tokenPathFor(config, target);
  const label = labelFor(target);

  oauth2Client.on("tokens", (tokens) => {
    const existing = loadTokens(tokenPath) || {};
    saveTokens(tokenPath, {
      ...existing,
      access_token: tokens.access_token ?? existing.access_token,
      refresh_token: tokens.refresh_token ?? existing.refresh_token,
      scope: tokens.scope ?? existing.scope,
      expiry_date: tokens.expiry_date ?? existing.expiry_date,
      token_type: tokens.token_type ?? existing.token_type,
    });
  });

  const saved = loadTokens(tokenPath);
  const refreshToken = saved?.refresh_token;

  if (refreshToken) {
    console.log(`🔑 Loading saved tokens (${label})...`);
    oauth2Client.setCredentials({
      access_token: saved.access_token,
      refresh_token: refreshToken,
      expiry_date: saved.expiry_date ?? undefined,
      scope: saved.scope,
      token_type: saved.token_type ?? undefined,
    });

    try {
      await oauth2Client.getAccessToken();
      console.log(`✅ Tokens ${label} valid, access refreshed.`);
      return oauth2Client;
    } catch (err) {
      const detail = describeOAuthFailure(err);
      console.log(`⚠️  Saved ${label} tokens không dùng được: ${detail}`);
      if (process.env.CI) {
        throw ciAuthFailure(
          target,
          label,
          `refresh token bị Google từ chối (${detail})`,
        );
      }
    }
  } else if (process.env.CI) {
    throw ciAuthFailure(
      target,
      label,
      existsSync(tokenPath)
        ? `token file ${tokenPath} không chứa refresh_token (thiếu, rỗng, hoặc JSON hỏng)`
        : `token file không tồn tại: ${tokenPath}`,
    );
  }

  return authorizeViaBrowser(config, credentials, target);
}