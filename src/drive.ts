import { google, drive_v3 } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { Readable } from "node:stream";

/** Video MIME types to match */
const VIDEO_MIME_TYPES = [
  "video/mp4",
  "video/quicktime",
  "video/x-msvideo",
  "video/x-matroska",
  "video/webm",
  "video/x-ms-wmv",
  "video/mpeg",
  "video/3gpp",
  "video/ogg",
];

/** Representation of a Drive video file */
export interface DriveVideo {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  createdTime: string;
}

/**
 * Create an authenticated Drive API client.
 */
export function createDriveClient(auth: OAuth2Client): drive_v3.Drive {
  return google.drive({ version: "v3", auth });
}

/**
 * List all video files in a Drive folder, recursing into sub-folders.
 * Handles pagination for folders with many files.
 */
export async function listVideosInFolder(
  drive: drive_v3.Drive,
  folderId: string,
): Promise<DriveVideo[]> {
  const videos: DriveVideo[] = [];
  const mimeQuery = VIDEO_MIME_TYPES.map((t) => `mimeType='${t}'`).join(" or ");

  const seen = new Set<string>();

  async function walk(currentFolderId: string): Promise<void> {
    if (seen.has(currentFolderId)) return;
    seen.add(currentFolderId);

    let pageToken: string | undefined;
    do {
      const res = await drive.files.list({
        q: `'${currentFolderId}' in parents and trashed=false`,
        fields:
          "nextPageToken, files(id, name, mimeType, size, createdTime)",
        pageSize: 100,
        pageToken,
        orderBy: "createdTime desc",
      });

      const files = res.data.files;
      if (files) {
        for (const f of files) {
          if (!f.id || !f.name || !f.mimeType) continue;

          if (f.mimeType === "application/vnd.google-apps.folder") {
            await walk(f.id);
          } else if (VIDEO_MIME_TYPES.includes(f.mimeType)) {
            if (f.size && f.createdTime) {
              videos.push({
                id: f.id,
                name: f.name,
                mimeType: f.mimeType,
                size: parseInt(f.size, 10),
                createdTime: f.createdTime,
              });
            }
          }
        }
      }

      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
  }

  await walk(folderId);
  return videos;
}

/**
 * Download a video file from Drive as a readable stream.
 */
export async function downloadVideo(
  drive: drive_v3.Drive,
  fileId: string,
): Promise<Readable> {
  const res = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "stream" },
  );

  return res.data as Readable;
}

/**
 * Get video metadata without downloading.
 */
export async function getVideoMetadata(
  drive: drive_v3.Drive,
  fileId: string,
): Promise<DriveVideo> {
  const res = await drive.files.get({
    fileId,
    fields: "id, name, mimeType, size, createdTime",
  });

  const f = res.data;
  if (!f.id || !f.name || !f.mimeType || !f.size || !f.createdTime) {
    throw new Error(`Incomplete metadata for file ${fileId}`);
  }

  return {
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    size: parseInt(f.size, 10),
    createdTime: f.createdTime,
  };
}
