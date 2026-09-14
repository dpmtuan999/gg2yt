import { config as dotenvConfig } from "dotenv";
import { resolve } from "node:path";

dotenvConfig();

export interface Config {
  /** Google Drive folder ID to monitor */
  driveFolderId: string;
  /** Polling interval in milliseconds */
  pollIntervalMs: number;
  /** Path to OAuth2 credentials.json */
  credentialsPath: string;
  /** Path to persisted OAuth2 tokens for the Google Drive account */
  driveTokenPath: string;
  /** Path to persisted OAuth2 tokens for the YouTube account */
  youtubeTokenPath: string;
  /** Path to processed files state */
  statePath: string;
  /** YouTube upload privacy status */
  youtubePrivacyStatus: "unlisted" | "private" | "public";
  /** Default YouTube video description */
  youtubeDefaultDescription: string;
  /** Port for OAuth2 callback server */
  oauthPort: number;
  /** First run: mark folder videos as done instead of uploading them all */
  skipExistingOnFirstRun: boolean;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export function loadConfig(): Config {
  const driveFolderId = requireEnv("GOOGLE_DRIVE_FOLDER_ID");

  return {
    driveFolderId,
    pollIntervalMs: parseInt(optionalEnv("POLL_INTERVAL_MS", "300000"), 10),
    credentialsPath: resolve(
      optionalEnv("CREDENTIALS_PATH", "./credentials/credentials.json"),
    ),
    driveTokenPath: resolve(
      optionalEnv("DRIVE_TOKEN_PATH", "./data/drive-token.json"),
    ),
    youtubeTokenPath: resolve(
      optionalEnv("YOUTUBE_TOKEN_PATH", "./data/youtube-token.json"),
    ),
    statePath: resolve(optionalEnv("STATE_PATH", "./data/processed.json")),
    youtubePrivacyStatus: optionalEnv(
      "YOUTUBE_PRIVACY_STATUS",
      "unlisted",
    ) as Config["youtubePrivacyStatus"],
    youtubeDefaultDescription: optionalEnv(
      "YOUTUBE_DEFAULT_DESCRIPTION",
      "",
    ),
    oauthPort: parseInt(optionalEnv("OAUTH_PORT", "3000"), 10),
    skipExistingOnFirstRun:
      optionalEnv("SKIP_EXISTING_ON_FIRST_RUN", "true").toLowerCase() === "true",
  };
}
