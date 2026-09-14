import { OAuth2Client } from "google-auth-library";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Config } from "./config.js";
import {
  createDriveClient,
  listVideosInFolder,
  downloadVideo,
  type DriveVideo,
} from "./drive.js";
import {
  createYouTubeClient,
  uploadVideo,
  type UploadResult,
} from "./youtube.js";

/** State of a processed file */
interface ProcessedFile {
  driveFileId: string;
  youtubeVideoId: string;
  youtubeUrl: string;
  processedAt: string;
  originalName: string;
}

/** Persisted state */
interface PollerState {
  processed: Record<string, ProcessedFile>;
}

/**
 * Load persisted state from disk.
 * Returns null when the state file does not exist yet (first run).
 */
function loadState(statePath: string): PollerState | null {
  if (!existsSync(statePath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(statePath, "utf-8")) as PollerState;
  } catch {
    console.log("⚠️  Could not parse state file, starting fresh.");
    return null;
  }
}

/**
 * Mark existing folder videos as processed so the first run
 * only picks up files added afterwards.
 */
function markExistingAsProcessed(
  state: PollerState,
  videos: DriveVideo[],
): void {
  for (const v of videos) {
    state.processed[v.id] = {
      driveFileId: v.id,
      youtubeVideoId: "skipped-on-first-run",
      youtubeUrl: "",
      processedAt: new Date().toISOString(),
      originalName: v.name,
    };
  }
}

/**
 * Initialize state on first run, honoring the skipExistingOnFirstRun flag.
 */
async function ensureInitialized(
  drive: ReturnType<typeof createDriveClient>,
  config: Config,
): Promise<PollerState> {
  let state = loadState(config.statePath);
  if (state !== null) {
    return state;
  }

  state = { processed: {} };

  if (config.skipExistingOnFirstRun) {
    const existing = await listVideosInFolder(drive, config.driveFolderId);
    markExistingAsProcessed(state, existing);
    saveState(config.statePath, state);
    console.log(
      `   ℹ️  First run — skipped ${existing.length} existing video(s) ` +
        "(chỉ upload file mới thêm sau này)",
    );
  }

  return state;
}

/**
 * Save state to disk.
 */
function saveState(statePath: string, state: PollerState): void {
  const dir = dirname(statePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
}

/**
 * Process a single video: download from Drive → upload to YouTube.
 */
async function processVideo(
  drive: ReturnType<typeof createDriveClient>,
  youtube: ReturnType<typeof createYouTubeClient>,
  video: DriveVideo,
  config: Config,
): Promise<ProcessedFile> {
  console.log(`\n🎬 Processing: "${video.name}" (${video.mimeType})`);

  // Download from Drive
  console.log("   ⬇️  Downloading from Google Drive...");
  const stream = await downloadVideo(drive, video.id);

  // Upload to YouTube
  const result: UploadResult = await uploadVideo(
    youtube,
    video.name,
    video.mimeType,
    video.size,
    stream,
    config.youtubePrivacyStatus,
    config.youtubeDefaultDescription,
  );

  return {
    driveFileId: video.id,
    youtubeVideoId: result.videoId,
    youtubeUrl: result.videoUrl,
    processedAt: new Date().toISOString(),
    originalName: video.name,
  };
}

/**
 * Run a single poll cycle:
 * 1. List videos in Drive folder
 * 2. Find unprocessed videos
 * 3. Upload each new video to YouTube
 * 4. Update state
 */
async function pollOnce(
  drive: ReturnType<typeof createDriveClient>,
  youtube: ReturnType<typeof createYouTubeClient>,
  config: Config,
  state: PollerState,
): Promise<PollerState> {
  const videos = await listVideosInFolder(drive, config.driveFolderId);

  // Filter to only unprocessed videos
  const newVideos = videos.filter(
    (v) => !(v.id in state.processed),
  );

  if (newVideos.length === 0) {
    console.log(
      `   ℹ️  No new videos found (${videos.length} total in folder)`,
    );
    return state;
  }

  console.log(`   📋 Found ${newVideos.length} new video(s) to process`);

  // Process videos sequentially to avoid YouTube rate limits
  for (const video of newVideos) {
    try {
      const processed = await processVideo(drive, youtube, video, config);
      state.processed[video.id] = processed;

      // Save state after each successful upload (crash recovery)
      saveState(config.statePath, state);
    } catch (err) {
      console.error(
        `   ❌ Failed to process "${video.name}":`,
        err instanceof Error ? err.message : err,
      );
      // Continue to next video — don't let one failure block the rest
    }
  }

  return state;
}

/**
 * Start the polling loop.
 * Checks for new videos at the configured interval.
 */
export async function startPoller(
  driveAuth: OAuth2Client,
  youtubeAuth: OAuth2Client,
  config: Config,
): Promise<void> {
  const drive = createDriveClient(driveAuth);
  const youtube = createYouTubeClient(youtubeAuth);
  let state = await ensureInitialized(drive, config);

  const processedCount = Object.keys(state.processed).length;
  console.log(`\n🔄 Poller starting (interval: ${config.pollIntervalMs / 1000}s)`);
  console.log(`   📁 Monitoring folder: ${config.driveFolderId}`);
  console.log(`   📊 Previously processed: ${processedCount} video(s)`);

  // Run first poll immediately
  state = await pollOnce(drive, youtube, config, state);

  // Set up interval
  const interval = setInterval(async () => {
    try {
      state = await pollOnce(drive, youtube, config, state);
    } catch (err) {
      console.error(
        "\n❌ Poll error:",
        err instanceof Error ? err.message : err,
      );
    }
  }, config.pollIntervalMs);

  // Return a cleanup function
  return new Promise((resolve) => {
    const cleanup = () => {
      clearInterval(interval);
      resolve();
    };

    // Expose cleanup via process events
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  });
}

/**
 * Run a single poll cycle and exit.
 * Useful for cron-based setups.
 */
export async function pollOnceAndExit(
  driveAuth: OAuth2Client,
  youtubeAuth: OAuth2Client,
  config: Config,
): Promise<void> {
  const drive = createDriveClient(driveAuth);
  const youtube = createYouTubeClient(youtubeAuth);
  const state = await ensureInitialized(drive, config);

  console.log(`\n🔄 Single poll (folder: ${config.driveFolderId})`);
  await pollOnce(drive, youtube, config, state);
}
