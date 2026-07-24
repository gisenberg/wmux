import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HttpError,
  type ApiRoute,
  routePolicy,
} from "./route.js";

const MAX_UPLOAD_BODY = 12 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

const attachmentExtensions: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/heic": "heic",
  "image/heif": "heif",
};

interface SavedPaneAttachment {
  id: string;
  paneId: string;
  name: string;
  mimeType: string;
  bytes: number;
  url: string;
  createdAt: string;
}

const attachmentRoot = (): string =>
  path.resolve(
    process.env.WMUX_ATTACHMENT_DIR
      ?? path.join(os.homedir(), ".wmux", "attachments"),
  );

const attachmentExtensionForMimeType = (mimeType: string): string | null =>
  attachmentExtensions[mimeType.toLowerCase()] ?? null;

const isBase64Data = (value: string): boolean =>
  value.length % 4 !== 1 && /^[A-Za-z0-9+/]*={0,2}$/.test(value);

const safePathSegment = (value: string, fallback: string): string => {
  const safe = value
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return safe || fallback;
};

const safeDisplayName = (name: string | undefined, fallback: string): string => {
  const trimmed = (name ?? "").trim();
  const baseName = trimmed ? path.basename(trimmed) : fallback;
  return baseName
    .replace(/[^\w .()[\]-]+/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 120) || fallback;
};

const safeFileBaseName = (name: string, fallback: string): string => {
  const withoutExtension = name.replace(/\.[^.]+$/, "");
  return safePathSegment(withoutExtension, fallback).slice(0, 80);
};

const savePaneAttachment = (
  paneId: string,
  input: {
    name?: string;
    mimeType: string;
    extension: string;
    buffer: Buffer;
  },
): SavedPaneAttachment => {
  const paneSegment = safePathSegment(paneId, "pane");
  const id = `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const displayName = safeDisplayName(
    input.name,
    `pasted-image.${input.extension}`,
  );
  const baseName = safeFileBaseName(displayName, "pasted-image");
  const fileName = `${id}-${baseName}.${input.extension}`;
  const paneDirectory = path.join(attachmentRoot(), paneSegment);
  fs.mkdirSync(paneDirectory, { recursive: true });
  fs.writeFileSync(path.join(paneDirectory, fileName), input.buffer, { flag: "wx" });
  return {
    id,
    paneId,
    name: displayName,
    mimeType: input.mimeType,
    bytes: input.buffer.length,
    url: `/api/attachments/${encodeURIComponent(paneSegment)}/${encodeURIComponent(fileName)}`,
    createdAt: new Date().toISOString(),
  };
};

const attachmentContentType = (filePath: string): string => {
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".jpg") || filePath.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (filePath.endsWith(".gif")) return "image/gif";
  if (filePath.endsWith(".webp")) return "image/webp";
  if (filePath.endsWith(".avif")) return "image/avif";
  if (filePath.endsWith(".bmp")) return "image/bmp";
  if (filePath.endsWith(".heic")) return "image/heic";
  if (filePath.endsWith(".heif")) return "image/heif";
  return "application/octet-stream";
};

const servePaneAttachment = (
  paneSegment: string,
  fileName: string,
  response: import("node:http").ServerResponse,
): boolean => {
  if (
    safePathSegment(paneSegment, "") !== paneSegment
    || path.basename(fileName) !== fileName
  ) {
    return false;
  }
  if (!/^[A-Za-z0-9._-]+$/.test(fileName)) return false;
  const paneDirectory = path.resolve(attachmentRoot(), paneSegment);
  const filePath = path.resolve(paneDirectory, fileName);
  if (!filePath.startsWith(`${paneDirectory}${path.sep}`)) return false;
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;
  const stat = fs.statSync(filePath);
  response.writeHead(200, {
    "content-type": attachmentContentType(fileName),
    "content-length": String(stat.size),
    "cache-control": "private, max-age=86400",
    "x-content-type-options": "nosniff",
  });
  fs.createReadStream(filePath).pipe(response);
  return true;
};

export const mediaRoutes: readonly ApiRoute[] = [
  {
    id: "media",
    method: "POST",
    pattern: "/api/media",
    policy: routePolicy("media", "POST", "/api/media", "normal", ["helper"]),
    handler: async ({ deps, readJsonBody, sendJson }) => {
      const body = (await readJsonBody(MAX_UPLOAD_BODY)) as {
        workspaceId?: string;
        tabId?: string;
        paneId?: string;
        name?: string;
        mimeType?: string;
        data?: string;
      };
      if (!body.data) {
        sendJson(400, { error: "missing_media_data" });
        return;
      }
      if (!isBase64Data(body.data.replace(/\s+/g, ""))) {
        sendJson(400, { error: "invalid_media_data" });
        return;
      }
      const media = deps.state.createMedia({
        workspaceId: body.workspaceId,
        tabId: body.tabId,
        paneId: body.paneId,
        name: body.name ?? "media",
        mimeType: body.mimeType ?? "application/octet-stream",
        data: body.data,
      });
      sendJson(201, { media });
    },
  },
  {
    id: "clipboard",
    method: "POST",
    pattern: "/api/clipboard",
    policy: routePolicy(
      "clipboard",
      "POST",
      "/api/clipboard",
      "normal",
      ["helper"],
    ),
    handler: async ({ deps, readJsonBody, sendJson }) => {
      const body = (await readJsonBody()) as {
        workspaceId?: string;
        tabId?: string;
        paneId?: string;
        text?: string;
      };
      if (typeof body.text !== "string" || body.text.length === 0) {
        sendJson(400, { error: "missing_clipboard_text" });
        return;
      }
      const clipboard = deps.state.createClipboard({
        workspaceId: body.workspaceId,
        tabId: body.tabId,
        paneId: body.paneId,
        text: body.text,
      });
      sendJson(201, { clipboard });
    },
  },
  {
    id: "pane-paste-image-stage",
    method: "POST",
    pattern: /^\/api\/panes\/([^/]+)\/paste-images$/,
    policy: routePolicy(
      "pane-paste-image-stage",
      "POST",
      /^\/api\/panes\/[^/]+\/paste-images$/,
    ),
    handler: async ({ deps, match, readBinaryBody, request, sendJson }) => {
      if (!match) throw new Error("paste image route matched without captures");
      const paneId = decodeURIComponent(match[1]);
      if (!deps.sessions.hasLivePaneSession(paneId)) {
        sendJson(deps.state.findPane(paneId) ? 409 : 404, {
          error: deps.state.findPane(paneId)
            ? "paste_image_pane_not_live"
            : "pane_not_found",
        });
        return;
      }
      const contentType = (request.headers["content-type"] ?? "")
        .split(";", 1)[0]
        .trim()
        .toLowerCase();
      if (contentType !== "application/octet-stream") {
        throw new HttpError(415, "paste_image_content_type_required");
      }
      const staged = await deps.sessions.stagePasteImage(
        paneId,
        await readBinaryBody(),
      );
      sendJson(201, {
        stageId: staged.stageId,
        targetPath: staged.targetPath,
        mimeType: staged.mimeType,
        bytes: staged.bytes,
        expiresAt: staged.expiresAt,
      });
    },
  },
  {
    id: "pane-paste-image-delete",
    method: "DELETE",
    pattern: /^\/api\/panes\/([^/]+)\/paste-images\/([^/]+)$/,
    policy: routePolicy(
      "pane-paste-image-delete",
      "DELETE",
      /^\/api\/panes\/[^/]+\/paste-images\/[^/]+$/,
    ),
    handler: async ({ deps, match, sendJson }) => {
      if (!match) throw new Error("paste image delete route matched without captures");
      const removed = await deps.sessions.discardPasteImage(
        decodeURIComponent(match[1]),
        decodeURIComponent(match[2]),
      );
      sendJson(removed ? 200 : 404, { removed });
    },
  },
  {
    id: "pane-attachment-create",
    method: "POST",
    pattern: /^\/api\/panes\/([^/]+)\/attachments$/,
    policy: routePolicy(
      "pane-attachment-create",
      "POST",
      /^\/api\/panes\/[^/]+\/attachments$/,
    ),
    handler: async ({ deps, match, readJsonBody, sendJson }) => {
      if (!match) throw new Error("attachment create route matched without captures");
      const paneId = decodeURIComponent(match[1]);
      if (!deps.state.findPane(paneId)) {
        sendJson(404, { error: "pane_not_found" });
        return;
      }
      const body = (await readJsonBody(MAX_UPLOAD_BODY)) as {
        name?: unknown;
        mimeType?: unknown;
        data?: unknown;
      };
      if (typeof body.data !== "string" || !body.data.trim()) {
        sendJson(400, { error: "missing_attachment_data" });
        return;
      }
      const mimeType = typeof body.mimeType === "string"
        ? body.mimeType.trim().toLowerCase()
        : "";
      const extension = attachmentExtensionForMimeType(mimeType);
      if (!extension) {
        sendJson(400, { error: "unsupported_attachment_type" });
        return;
      }
      const encodedData = body.data.replace(/\s+/g, "");
      if (!isBase64Data(encodedData)) {
        sendJson(400, { error: "invalid_attachment_data" });
        return;
      }
      const buffer = Buffer.from(encodedData, "base64");
      if (buffer.length === 0) {
        sendJson(400, { error: "empty_attachment" });
        return;
      }
      if (buffer.length > MAX_ATTACHMENT_BYTES) {
        sendJson(413, { error: "attachment_too_large" });
        return;
      }
      const attachment = savePaneAttachment(paneId, {
        name: typeof body.name === "string" ? body.name : undefined,
        mimeType,
        extension,
        buffer,
      });
      sendJson(201, { attachment });
    },
  },
  {
    id: "attachment-read",
    method: "GET",
    pattern: /^\/api\/attachments\/([^/]+)\/([^/]+)$/,
    policy: routePolicy(
      "attachment-read",
      "GET",
      /^\/api\/attachments\/[^/]+\/[^/]+$/,
    ),
    handler: async ({ match, response, sendJson }) => {
      if (!match) throw new Error("attachment read route matched without captures");
      if (
        servePaneAttachment(
          decodeURIComponent(match[1]),
          decodeURIComponent(match[2]),
          response,
        )
      ) {
        return;
      }
      sendJson(404, { error: "attachment_not_found" });
    },
  },
];
