import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ViteDevServer } from "vite";

const bundledMesloFontFiles = {
  regular: "meslo-lgm-nerd-font-mono-regular.woff2",
  bold: "meslo-lgm-nerd-font-mono-bold.woff2",
  italic: "meslo-lgm-nerd-font-mono-italic.woff2",
  "bold-italic": "meslo-lgm-nerd-font-mono-bold-italic.woff2",
} as const;

type BundledMesloFontFace = keyof typeof bundledMesloFontFiles;

export const clientRoot = (): string => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../client");
};

const contentType = (filePath: string): string => {
  if (filePath.endsWith(".html")) return "text/html";
  if (filePath.endsWith(".js")) return "text/javascript";
  if (filePath.endsWith(".css")) return "text/css";
  if (filePath.endsWith(".woff")) return "font/woff";
  if (filePath.endsWith(".woff2")) return "font/woff2";
  if (filePath.endsWith(".wasm")) return "application/wasm";
  return "application/octet-stream";
};

const staticHeaders = (filePath: string): Record<string, string> => {
  const headers: Record<string, string> = {
    "content-type": contentType(filePath),
  };
  if (filePath.endsWith(".html")) {
    headers["cache-control"] = "no-store";
  } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
    headers["cache-control"] = "public, max-age=31536000, immutable";
  }
  return headers;
};

const serveViteRequest = async (
  vite: ViteDevServer,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  url: URL,
  root: string,
): Promise<boolean> => {
  try {
    await new Promise<void>((resolve, reject) => {
      vite.middlewares(request, response, (error?: unknown) => {
        if (error) reject(error);
        else resolve();
      });
    });
    if (response.writableEnded || response.headersSent) return true;
    const indexPath = path.join(root, "index.html");
    if (!fs.existsSync(indexPath)) return false;
    const html = await vite.transformIndexHtml(
      url.pathname,
      fs.readFileSync(indexPath, "utf8"),
    );
    response.writeHead(200, staticHeaders(indexPath));
    response.end(html);
    return true;
  } catch (error) {
    if (error instanceof Error) vite.ssrFixStacktrace(error);
    throw error;
  }
};

const serveBundledMesloFont = (
  root: string,
  face: BundledMesloFontFace,
  headOnly: boolean,
  response: http.ServerResponse,
): boolean => {
  const fileName = bundledMesloFontFiles[face];
  const candidates = [
    path.join(root, "fonts", "meslo", fileName),
    path.join(root, "public", "fonts", "meslo", fileName),
  ];
  const filePath = candidates.find(
    (candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile(),
  );
  if (!filePath) return false;
  const stat = fs.statSync(filePath);
  response.writeHead(200, {
    "content-type": "font/woff2",
    "content-length": String(stat.size),
    "cache-control": "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
  });
  if (headOnly) response.end();
  else fs.createReadStream(filePath).pipe(response);
  return true;
};

export const serveBundledFontRequest = (
  request: http.IncomingMessage,
  response: http.ServerResponse,
  pathname: string,
  root: string,
): boolean => {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const match = pathname.match(
    /^\/fonts\/meslo-v3\.4\.0\/(regular|bold|italic|bold-italic)$/,
  );
  if (!match) return false;
  return serveBundledMesloFont(
    root,
    match[1] as BundledMesloFontFace,
    request.method === "HEAD",
    response,
  );
};

export const serveStaticRequest = async (
  request: http.IncomingMessage,
  response: http.ServerResponse,
  url: URL,
  root: string,
  vite?: ViteDevServer,
): Promise<boolean> => {
  if (request.method !== "GET") return false;
  if (vite && await serveViteRequest(vite, request, response, url, root)) {
    return true;
  }
  const filePath = url.pathname === "/"
    ? path.join(root, "index.html")
    : path.join(root, url.pathname);
  const normalized = path.normalize(filePath);
  if (
    (normalized === root || normalized.startsWith(`${root}${path.sep}`))
    && fs.existsSync(normalized)
    && fs.statSync(normalized).isFile()
  ) {
    response.writeHead(200, staticHeaders(normalized));
    fs.createReadStream(normalized).pipe(response);
    return true;
  }
  const index = path.join(root, "index.html");
  if (!fs.existsSync(index)) return false;
  response.writeHead(200, staticHeaders(index));
  fs.createReadStream(index).pipe(response);
  return true;
};
