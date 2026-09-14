import { google, youtube_v3 } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { Readable } from "node:stream";

/** YouTube upload result */
export interface UploadResult {
  videoId: string;
  videoUrl: string;
  title: string;
  privacyStatus: string;
}

/**
 * Create an authenticated YouTube API client.
 */
export function createYouTubeClient(auth: OAuth2Client): youtube_v3.Youtube {
  return google.youtube({ version: "v3", auth });
}

/**
 * Extract a clean title from a filename (remove extension).
 */
function videoTitleFromFilename(filename: string): string {
  // Remove common video extensions
  const extPattern = /\.(mp4|mov|avi|mkv|webm|wmv|mpeg|3gp|ogv)$/i;
  return filename.replace(extPattern, "").trim();
}

/**
 * Format file size for display.
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Upload a video to YouTube using resumable upload.
 *
 * @param youtube - Authenticated YouTube client
 * @param filename - Original filename (used as video title)
 * @param mimeType - Video MIME type
 * @param fileSize - Size in bytes (for progress display)
 * @param videoStream - Readable stream of the video content
 * @param privacyStatus - 'unlisted' | 'private' | 'public'
 * @param description - Optional video description
 * @returns Upload result with video ID and URL
 */
export async function uploadVideo(
  youtube: youtube_v3.Youtube,
  filename: string,
  mimeType: string,
  fileSize: number,
  videoStream: Readable,
  privacyStatus: "unlisted" | "private" | "public" = "unlisted",
  description: string = "",
): Promise<UploadResult> {
  const title = videoTitleFromFilename(filename);

  console.log(`   📤 Uploading: "${title}" (${formatSize(fileSize)})`);
  console.log(`   📋 Privacy: ${privacyStatus}`);

  const res = await youtube.videos.insert(
    {
      part: ["snippet", "status"],
      requestBody: {
        snippet: {
          title,
          description: description || `Uploaded from Google Drive: ${filename}`,
          tags: ["auto-upload", "google-drive"],
        },
        status: {
          privacyStatus,
          selfDeclaredMadeForKids: false,
        },
      },
      media: {
        mimeType,
        body: videoStream,
      },
    },
    {
      // Use resumable upload for files > 5MB
      // The googleapis client handles this automatically for streams
      timeout: 30 * 60 * 1000, // 30 minute timeout for large files
    },
  );

  const videoId = res.data.id;
  if (!videoId) {
    throw new Error("Upload succeeded but no video ID returned");
  }

  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

  console.log(`   ✅ Uploaded: ${videoUrl}`);

  return {
    videoId,
    videoUrl,
    title,
    privacyStatus,
  };
}
