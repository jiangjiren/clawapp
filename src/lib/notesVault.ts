import { promises as fs, readFileSync, existsSync } from "fs";
import { createHash } from "crypto";
import path from "path";
import type {
  MentionEntry,
  MentionEntryKind,
  NotesDirectoryNode,
  NotesFileNode,
  NotesSearchHit,
  NotesTreeNode,
} from "@/lib/notesTypes";

const DEFAULT_VAULT_PATH = path.join(process.cwd(), "vault");

const EXCLUDED_DIRECTORY_NAMES = new Set([
  ".git",
  ".obsidian",
  ".claude",
  ".claudian",
  "node_modules",
]);

const IMAGE_EXTENSIONS = new Set([
  ".avif",
  ".gif",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".webp",
]);

const MIME_TYPES: Record<string, string> = {
  ".aac": "audio/aac",
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".eot": "application/vnd.ms-fontobject",
  ".gif": "image/gif",
  ".htm": "text/html; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".m4a": "audio/mp4",
  ".md": "text/markdown; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".oga": "audio/ogg",
  ".ogg": "audio/ogg",
  ".ogv": "video/ogg",
  ".otf": "font/otf",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".xml": "application/xml; charset=utf-8",
};

export class VaultAccessError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "VaultAccessError";
    this.status = status;
  }
}

const getTauriConfigVaultPath = (): string | null => {
  try {
    let configPath = "";
    if (process.platform === "win32") {
      configPath = path.join(process.env.APPDATA || "", "com.tauri.dev", "config.json");
    } else if (process.platform === "darwin") {
      configPath = path.join(
        process.env.HOME || "",
        "Library",
        "Application Support",
        "com.tauri.dev",
        "config.json"
      );
    } else {
      const configHome = process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || "", ".config");
      configPath = path.join(configHome, "com.tauri.dev", "config.json");
    }

    if (existsSync(configPath)) {
      const content = readFileSync(configPath, "utf8");
      const config = JSON.parse(content) as { vault_path?: string };
      if (config.vault_path && existsSync(config.vault_path)) {
        return config.vault_path;
      }
    }
  } catch {
    // Ignore error and fall back
  }
  return null;
};

const getConfiguredVaultPath = () =>
  process.env.VAULT_PATH?.trim() || getTauriConfigVaultPath() || DEFAULT_VAULT_PATH;

const toVaultPath = (relativePath: string) => relativePath.split(path.sep).join("/");

const hasExcludedSegment = (relativePath: string) =>
  relativePath
    .split("/")
    .filter(Boolean)
    .some((segment) => EXCLUDED_DIRECTORY_NAMES.has(segment));

const decodeLoose = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const sanitizeRelativePath = (input: string, { allowEmpty = false } = {}) => {
  const decoded = decodeLoose(input).replace(/\\/g, "/").trim();

  if (!decoded) {
    if (allowEmpty) {
      return "";
    }
    throw new VaultAccessError("Missing path.");
  }

  if (decoded.includes("\0")) {
    throw new VaultAccessError("Invalid path.");
  }

  const normalized = path.posix.normalize(decoded.replace(/^\/+/, ""));
  if (!normalized || normalized === ".") {
    if (allowEmpty) {
      return "";
    }
    throw new VaultAccessError("Missing path.");
  }

  const segments = normalized.split("/");
  if (segments.some((segment) => segment === ".." || segment === "")) {
    throw new VaultAccessError("Path traversal is not allowed.", 403);
  }

  if (hasExcludedSegment(normalized)) {
    throw new VaultAccessError("This path is excluded.", 403);
  }

  return normalized;
};

const getVaultRoot = async () => {
  const configuredPath = path.resolve(getConfiguredVaultPath());
  try {
    return await fs.realpath(configuredPath);
  } catch {
    throw new VaultAccessError("Vault path is unavailable.", 503);
  }
};

const assertInsideVault = (absolutePath: string, vaultRoot: string) => {
  if (absolutePath !== vaultRoot && !absolutePath.startsWith(`${vaultRoot}${path.sep}`)) {
    throw new VaultAccessError("Path traversal is not allowed.", 403);
  }
};

const resolveExistingVaultPath = async (relativePath: string) => {
  const vaultRoot = await getVaultRoot();
  const sanitizedPath = sanitizeRelativePath(relativePath);
  const candidate = path.resolve(vaultRoot, sanitizedPath);
  assertInsideVault(candidate, vaultRoot);

  let realPath: string;
  try {
    realPath = await fs.realpath(candidate);
  } catch {
    throw new VaultAccessError("File not found.", 404);
  }

  assertInsideVault(realPath, vaultRoot);
  const realRelativePath = toVaultPath(path.relative(vaultRoot, realPath));
  if (hasExcludedSegment(realRelativePath)) {
    throw new VaultAccessError("This path is excluded.", 403);
  }

  return {
    absolutePath: realPath,
    relativePath: realRelativePath,
  };
};

const resolveExistingVaultPathIfAllowed = async (relativePath: string) => {
  try {
    return await resolveExistingVaultPath(relativePath);
  } catch {
    return null;
  }
};

const isMarkdownPath = (relativePath: string) => path.extname(relativePath).toLowerCase() === ".md";

const HTML_EXTENSIONS = new Set([".html", ".htm"]);
const isHtmlPath = (relativePath: string) => HTML_EXTENSIONS.has(path.extname(relativePath).toLowerCase());

// PDF/图片仅用于只读预览，不可编辑。
const isNoteFile = (name: string) => isMarkdownPath(name) || isHtmlPath(name) || isPdfPath(name) || isImagePath(name);

const isImagePath = (relativePath: string) => IMAGE_EXTENSIONS.has(path.extname(relativePath).toLowerCase());

const isPdfPath = (relativePath: string) => path.extname(relativePath).toLowerCase() === ".pdf";

const sanitizeNameSegment = (input: string) => {
  const decoded = decodeLoose(input).replace(/\\/g, "/").trim();
  if (!decoded) {
    throw new VaultAccessError("Missing name.");
  }
  if (decoded.includes("/") || decoded.includes("\0")) {
    throw new VaultAccessError("Invalid name.");
  }
  if (decoded === "." || decoded === "..") {
    throw new VaultAccessError("Invalid name.");
  }
  if (EXCLUDED_DIRECTORY_NAMES.has(decoded)) {
    throw new VaultAccessError("This name is excluded.", 403);
  }
  return decoded;
};

const compareNodes = (left: NotesTreeNode, right: NotesTreeNode) => {
  if (left.type !== right.type) {
    return left.type === "directory" ? -1 : 1;
  }
  return left.name.localeCompare(right.name, "zh-Hans", { numeric: true, sensitivity: "base" });
};

const walkDirectory = async (absolutePath: string, relativePath: string): Promise<NotesDirectoryNode> => {
  const entries = await fs.readdir(absolutePath, { withFileTypes: true });
  const children: NotesTreeNode[] = [];

  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue;
    }

    const childRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    if (hasExcludedSegment(childRelativePath)) {
      continue;
    }

    const childAbsolutePath = path.join(absolutePath, entry.name);

    if (entry.isDirectory()) {
      const directory = await walkDirectory(childAbsolutePath, childRelativePath);
      // Include all non-excluded directories, even empty ones (user may have just created them)
      children.push(directory);
      continue;
    }

    if (!entry.isFile() || !isNoteFile(entry.name)) {
      continue;
    }

    const stat = await fs.stat(childAbsolutePath);
    children.push({
      type: "file",
      name: entry.name,
      path: childRelativePath,
      size: stat.size,
      updatedAt: stat.mtime.toISOString(),
    } satisfies NotesFileNode);
  }

  children.sort(compareNodes);

  return {
    type: "directory",
    name: relativePath ? path.posix.basename(relativePath) : path.basename(await getVaultRoot()),
    path: relativePath,
    children,
  };
};

// 只读返回二进制文档字节（PDF / 图片），供前端预览。
// 服务端不做任何渲染/转换，仅按精确路径读取文件并流回字节。
export const readVaultDocument = async (relativePath: string) => {
  const resolved = await resolveExistingVaultPath(relativePath);
  const ext = path.extname(resolved.relativePath).toLowerCase();
  if (!isPdfPath(resolved.relativePath) && !isImagePath(resolved.relativePath)) {
    throw new VaultAccessError("Only PDF and image files can be previewed.", 415);
  }
  const stat = await fs.stat(resolved.absolutePath);
  if (!stat.isFile()) {
    throw new VaultAccessError("File not found.", 404);
  }
  return {
    body: await fs.readFile(resolved.absolutePath),
    contentType: MIME_TYPES[ext] ?? "application/octet-stream",
    size: stat.size,
    updatedAt: stat.mtime.toUTCString(),
    fileName: path.basename(resolved.relativePath),
  };
};

// HTML 预览的相对资源（CSS、脚本、字体、图片、音视频等）。路径仍统一经过
// resolveExistingVaultPath，沿用 vault 边界、排除目录和符号链接校验。
export const readVaultHtmlAsset = async (relativePath: string) => {
  const resolved = await resolveExistingVaultPath(relativePath);
  const stat = await fs.stat(resolved.absolutePath);
  if (!stat.isFile()) {
    throw new VaultAccessError("HTML preview asset not found.", 404);
  }

  const ext = path.extname(resolved.relativePath).toLowerCase();
  return {
    body: await fs.readFile(resolved.absolutePath),
    contentType: MIME_TYPES[ext] ?? "application/octet-stream",
    size: stat.size,
    updatedAt: stat.mtime.toUTCString(),
  };
};

export const getNotesTree = async () => {
  const vaultRoot = await getVaultRoot();
  return walkDirectory(vaultRoot, "");
};

const SEARCH_RESULT_LIMIT = 80;
const SEARCH_CONCURRENCY = 12;

const makeSearchSnippet = (content: string, normalizedQuery: string) => {
  const matchingLine = content
    .split(/\r?\n/)
    .find((line) => line.normalize("NFKC").toLocaleLowerCase().includes(normalizedQuery));

  return matchingLine
    ? Array.from(matchingLine.trim().replace(/\s+/g, " ")).slice(0, 180).join("")
    : "";
};

export const searchNotes = async (query: string): Promise<NotesSearchHit[]> => {
  const trimmedQuery = query.trim();
  if (trimmedQuery.length < 2 && !/[^\u0000-\u007f]/.test(trimmedQuery)) {
    return [];
  }
  if (Array.from(trimmedQuery).length > 200) {
    throw new VaultAccessError("Search query is too long.");
  }

  const normalizedQuery = trimmedQuery.normalize("NFKC").toLocaleLowerCase();
  const vaultRoot = await getVaultRoot();
  const tree = await walkDirectory(vaultRoot, "");
  const textFiles: NotesFileNode[] = [];

  const collectTextFiles = (node: NotesTreeNode) => {
    if (node.type === "file") {
      if (isMarkdownPath(node.path) || isHtmlPath(node.path)) {
        textFiles.push(node);
      }
      return;
    }
    for (const child of node.children) {
      collectTextFiles(child);
    }
  };
  collectTextFiles(tree);

  const rankedHits: Array<NotesSearchHit & { score: number }> = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < textFiles.length && rankedHits.length < SEARCH_RESULT_LIMIT) {
      const file = textFiles[cursor++];
      const normalizedName = file.name.normalize("NFKC").toLocaleLowerCase();
      const normalizedPath = file.path.normalize("NFKC").toLocaleLowerCase();
      const normalizedStem = path.basename(file.name, path.extname(file.name))
        .normalize("NFKC")
        .toLocaleLowerCase();
      const nameOrPathMatch =
        normalizedName.includes(normalizedQuery) || normalizedPath.includes(normalizedQuery);
      const absolutePath = path.join(vaultRoot, file.path.replace(/\//g, path.sep));

      let content = "";
      try {
        content = await fs.readFile(absolutePath, "utf8");
      } catch {
        if (!nameOrPathMatch) {
          continue;
        }
      }

      const snippet = makeSearchSnippet(content, normalizedQuery);
      if (!nameOrPathMatch && !snippet) {
        continue;
      }

      let score = 3;
      if (normalizedStem === normalizedQuery || normalizedPath === normalizedQuery) {
        score = 0;
      } else if (
        normalizedStem.startsWith(normalizedQuery) ||
        normalizedPath.startsWith(normalizedQuery)
      ) {
        score = 1;
      } else if (nameOrPathMatch) {
        score = 2;
      }

      rankedHits.push({
        path: file.path,
        name: file.name,
        snippet,
        score,
      });
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(SEARCH_CONCURRENCY, textFiles.length) }, () => worker()),
  );

  return rankedHits
    .sort((left, right) =>
      left.score - right.score ||
      left.name.localeCompare(right.name, "zh-Hans", { numeric: true, sensitivity: "base" }) ||
      left.path.localeCompare(right.path, "zh-Hans", { numeric: true, sensitivity: "base" }),
    )
    .slice(0, SEARCH_RESULT_LIMIT)
    .map((hit) => ({
      path: hit.path,
      name: hit.name,
      snippet: hit.snippet,
    }));
};

// 结构指纹：收集所有节点路径并哈希。只反映「有哪些文件/文件夹」，
// 不含 size/mtime，因此纯内容编辑不会改变它——客户端据此轮询，仅在
// 增/删/改名时才刷新文件树。
export const computeTreeRev = (root: NotesDirectoryNode): string => {
  const paths: string[] = [];
  const walk = (node: NotesTreeNode) => {
    paths.push(`${node.type === "directory" ? "d" : "f"}:${node.path}`);
    if (node.type === "directory") {
      for (const child of node.children) walk(child);
    }
  };
  walk(root);
  paths.sort();
  return createHash("sha1").update(paths.join("\n")).digest("hex");
};

export const resolveVaultPath = resolveExistingVaultPath;

// 只读取文件元数据（修改时间），不加载内容，供轮询检测变化用
export const statMarkdownNote = async (relativePath: string) => {
  const resolved = await resolveExistingVaultPath(relativePath);
  if (!isMarkdownPath(resolved.relativePath) && !isHtmlPath(resolved.relativePath)) {
    throw new VaultAccessError("Only Markdown and HTML files can be read.", 415);
  }
  const stat = await fs.stat(resolved.absolutePath);
  return {
    path: resolved.relativePath,
    updatedAt: stat.mtime.toISOString(),
  };
};

export const readMarkdownNote = async (relativePath: string) => {
  const resolved = await resolveExistingVaultPath(relativePath);
  if (!isMarkdownPath(resolved.relativePath) && !isHtmlPath(resolved.relativePath)) {
    throw new VaultAccessError("Only Markdown and HTML files can be read.", 415);
  }

  const stat = await fs.stat(resolved.absolutePath);
  if (!stat.isFile()) {
    throw new VaultAccessError("File not found.", 404);
  }

  const content = await fs.readFile(resolved.absolutePath, "utf8");
  return {
    name: path.basename(resolved.relativePath),
    path: resolved.relativePath,
    content,
    size: stat.size,
    updatedAt: stat.mtime.toISOString(),
  };
};

const stripFragmentAndQuery = (value: string) => value.split("#", 1)[0].split("?", 1)[0];

const findImageByFileName = async (
  directory: string,
  relativePath: string,
  wantedName: string,
): Promise<string | null> => {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const sortedEntries = [...entries].sort((left, right) =>
    left.name.localeCompare(right.name, "zh-Hans", { numeric: true, sensitivity: "base" }),
  );

  for (const entry of sortedEntries) {
    if (entry.isSymbolicLink()) {
      continue;
    }

    const childRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    if (hasExcludedSegment(childRelativePath)) {
      continue;
    }

    const childAbsolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const match = await findImageByFileName(childAbsolutePath, childRelativePath, wantedName);
      if (match) {
        return match;
      }
      continue;
    }

    if (
      entry.isFile() &&
      entry.name.toLocaleLowerCase() === wantedName &&
      isImagePath(entry.name)
    ) {
      return childRelativePath;
    }
  }

  return null;
};

export const readVaultImage = async (assetPath: string, fromPath?: string | null) => {
  const rawAssetPath = decodeLoose(stripFragmentAndQuery(assetPath).split("|", 1)[0])
    .replace(/\\/g, "/")
    .trim();

  if (!rawAssetPath || rawAssetPath.includes("\0")) {
    throw new VaultAccessError("Missing asset path.");
  }

  const assetPathWithoutLeadingSlash = rawAssetPath.replace(/^\/+/, "");
  const candidates: string[] = [];

  if (fromPath) {
    try {
      const cleanFromPath = sanitizeRelativePath(fromPath);
      const fromDirectory = path.posix.dirname(cleanFromPath);
      candidates.push(
        sanitizeRelativePath(
          path.posix.normalize(
            path.posix.join(fromDirectory === "." ? "" : fromDirectory, assetPathWithoutLeadingSlash),
          ),
        ),
      );
    } catch {
      // Ignore invalid context and try vault-root candidates below.
    }
  }

  try {
    candidates.push(sanitizeRelativePath(assetPathWithoutLeadingSlash));
  } catch {
    if (candidates.length === 0) {
      throw new VaultAccessError("Invalid asset path.");
    }
  }

  for (const candidate of candidates) {
    const resolved = await resolveExistingVaultPathIfAllowed(candidate);
    if (!resolved || !isImagePath(resolved.relativePath)) {
      continue;
    }

    const stat = await fs.stat(resolved.absolutePath);
    if (!stat.isFile()) {
      continue;
    }

    const extension = path.extname(resolved.relativePath).toLowerCase();
    return {
      body: await fs.readFile(resolved.absolutePath),
      contentType: MIME_TYPES[extension] ?? "application/octet-stream",
      size: stat.size,
      updatedAt: stat.mtime.toUTCString(),
    };
  }

  const vaultRoot = await getVaultRoot();
  const fileName = path.posix.basename(assetPathWithoutLeadingSlash).toLocaleLowerCase();
  const match = await findImageByFileName(vaultRoot, "", fileName);
  if (!match) {
    throw new VaultAccessError("Image not found.", 404);
  }

  const resolved = await resolveExistingVaultPath(match);
  const stat = await fs.stat(resolved.absolutePath);
  const extension = path.extname(resolved.relativePath).toLowerCase();

  return {
    body: await fs.readFile(resolved.absolutePath),
    contentType: MIME_TYPES[extension] ?? "application/octet-stream",
    size: stat.size,
    updatedAt: stat.mtime.toUTCString(),
  };
};

export const readVaultImageFromNoteDirectory = async (assetPath: string, notePath: string) => {
  const rawAssetPath = decodeLoose(stripFragmentAndQuery(assetPath).split("|", 1)[0])
    .replace(/\\/g, "/")
    .trim();

  if (!rawAssetPath || rawAssetPath.includes("\0")) {
    throw new VaultAccessError("Missing asset path.");
  }

  const cleanNotePath = sanitizeRelativePath(notePath);
  const noteDirectory = path.posix.dirname(cleanNotePath);
  const assetPathWithoutLeadingSlash = rawAssetPath.replace(/^\/+/, "");
  const candidate = sanitizeRelativePath(
    path.posix.normalize(
      path.posix.join(noteDirectory === "." ? "" : noteDirectory, assetPathWithoutLeadingSlash),
    ),
  );
  const resolved = await resolveExistingVaultPath(candidate);

  if (!isImagePath(resolved.relativePath)) {
    throw new VaultAccessError("Only image assets can be read.", 415);
  }

  const stat = await fs.stat(resolved.absolutePath);
  if (!stat.isFile()) {
    throw new VaultAccessError("Image not found.", 404);
  }

  const extension = path.extname(resolved.relativePath).toLowerCase();
  return {
    body: await fs.readFile(resolved.absolutePath),
    contentType: MIME_TYPES[extension] ?? "application/octet-stream",
    size: stat.size,
    updatedAt: stat.mtime.toUTCString(),
  };
};

// ── 编辑器粘贴图片（与桌面端 paste_image 约定一致） ──────────
export const PASTED_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

const PASTED_IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** 魔数校验：声明的 MIME 必须与实际字节头一致 */
const isValidPastedImage = (mimeType: string, bytes: Buffer) => {
  switch (mimeType) {
    case "image/png":
      return bytes.length > 8 &&
        bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case "image/jpeg":
      return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "image/gif": {
      const header = bytes.subarray(0, 6).toString("latin1");
      return bytes.length > 6 && (header === "GIF87a" || header === "GIF89a");
    }
    case "image/webp":
      return bytes.length > 12 &&
        bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
        bytes.subarray(8, 12).toString("latin1") === "WEBP";
    default:
      return false;
  }
};

const pastedImageTimestamp = (date = new Date()) => {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
};

/** 剪贴板文件名通常是 image.png 这类无信息名，换成时间戳；有意义的原名保留 */
const pastedImageBaseName = (originalName: string) => {
  const stem = decodeLoose(originalName).replace(/\\/g, "/").trim().split("/").pop()!.replace(/\.[^.]+$/, "");
  const generic = /^(?:image|screenshot|screen[-_ ]?shot|clipboard|pasted[-_ ]?image)(?:[-_ ]?\d+)?$/i;
  if (!stem || stem === "." || stem === ".." || generic.test(stem) || stem.includes("\0")) {
    return `image-${pastedImageTimestamp()}`;
  }
  return stem;
};

export const writePastedImage = async (
  notePath: string,
  originalName: string,
  mimeType: string,
  data: Buffer,
) => {
  const extension = PASTED_IMAGE_EXTENSIONS[mimeType.toLowerCase()];
  if (!extension) {
    throw new VaultAccessError("仅支持 PNG、JPEG、WebP 和 GIF 图片。", 415);
  }
  if (data.length === 0) {
    throw new VaultAccessError("图片内容为空。");
  }
  if (data.length > PASTED_IMAGE_MAX_BYTES) {
    throw new VaultAccessError("图片不能超过 20 MB。", 413);
  }
  if (!isValidPastedImage(mimeType.toLowerCase(), data)) {
    throw new VaultAccessError("剪贴板图片格式无效。", 415);
  }

  const note = await resolveExistingVaultPath(notePath);
  if (!isMarkdownPath(note.relativePath)) {
    throw new VaultAccessError("图片只能粘贴到 Markdown 笔记。", 415);
  }

  const noteDirectory = path.dirname(note.absolutePath);
  const relativeDirectory = path.posix.dirname(note.relativePath);
  const baseName = pastedImageBaseName(originalName);

  // 与桌面端一致：存到笔记同目录，重名追加 -2..-9999 后缀，create_new 防覆盖
  for (let suffix = 1; suffix <= 9999; suffix++) {
    const fileName = `${baseName}${suffix === 1 ? "" : `-${suffix}`}.${extension}`;
    const absolutePath = path.join(noteDirectory, fileName);
    try {
      await fs.writeFile(absolutePath, data, { flag: "wx" });
      const relativePath = relativeDirectory === "." ? fileName : `${relativeDirectory}/${fileName}`;
      return { name: fileName, path: relativePath };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
  }
  throw new VaultAccessError("无法为图片生成文件名。", 500);
};

export const updateMarkdownNote = async (relativePath: string, content: string) => {
  const resolved = await resolveExistingVaultPath(relativePath);
  if (!isMarkdownPath(resolved.relativePath)) {
    throw new VaultAccessError("Only .md files can be edited.", 415);
  }
  await fs.writeFile(resolved.absolutePath, content, "utf8");
  const stat = await fs.stat(resolved.absolutePath);
  return {
    name: path.basename(resolved.relativePath),
    path: resolved.relativePath,
    content,
    size: stat.size,
    updatedAt: stat.mtime.toISOString(),
    aliases: extractFrontMatterAliases(content),
  };
};

export const createMarkdownNote = async (relativePath: string, content = "") => {
  const sanitized = sanitizeRelativePath(relativePath);

  if (!isMarkdownPath(sanitized)) {
    throw new VaultAccessError("Only .md files can be created.", 415);
  }

  const vaultRoot = await getVaultRoot();
  const absolutePath = path.resolve(vaultRoot, sanitized);
  assertInsideVault(absolutePath, vaultRoot);

  // Refuse to overwrite an existing file
  try {
    await fs.access(absolutePath);
    throw new VaultAccessError("A file with this name already exists.", 409);
  } catch (err) {
    if (err instanceof VaultAccessError) throw err;
    // ENOENT → file doesn't exist, which is what we want
  }

  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, "utf8");

  const stat = await fs.stat(absolutePath);
  return {
    name: path.basename(sanitized),
    path: sanitized,
    content,
    size: stat.size,
    updatedAt: stat.mtime.toISOString(),
    aliases: extractFrontMatterAliases(content),
  };
};

const stripMarkdownExtension = (value: string) => value.replace(/\.md$/i, "");

const transformOutsideInlineCode = (
  content: string,
  transform: (plainText: string) => string,
) => {
  const openerPattern = /`+/g;
  let cursor = 0;
  let output = "";
  let opener: RegExpExecArray | null;

  while ((opener = openerPattern.exec(content)) !== null) {
    const closeIndex = content.indexOf(opener[0], opener.index + opener[0].length);
    if (closeIndex === -1 || content.slice(opener.index, closeIndex).includes("\n")) break;
    output += transform(content.slice(cursor, opener.index));
    output += content.slice(opener.index, closeIndex + opener[0].length);
    cursor = closeIndex + opener[0].length;
    openerPattern.lastIndex = cursor;
  }

  return output + transform(content.slice(cursor));
};

const maskInlineCode = (content: string) => {
  const openerPattern = /`+/g;
  let cursor = 0;
  let output = "";
  let opener: RegExpExecArray | null;

  while ((opener = openerPattern.exec(content)) !== null) {
    const closeIndex = content.indexOf(opener[0], opener.index + opener[0].length);
    if (closeIndex === -1 || content.slice(opener.index, closeIndex).includes("\n")) break;
    output += content.slice(cursor, opener.index);
    output += content
      .slice(opener.index, closeIndex + opener[0].length)
      .replace(/[^\n]/g, " ");
    cursor = closeIndex + opener[0].length;
    openerPattern.lastIndex = cursor;
  }

  return output + content.slice(cursor);
};

const rewriteWikiLinksForRename = (
  content: string,
  sourceOldPath: string,
  sourceCurrentPath: string,
  oldPath: string,
  nextPath: string,
  kind: "file" | "folder",
  oldFilePaths: string[],
) => {
  const oldPathKey = stripMarkdownExtension(oldPath).toLocaleLowerCase();
  const oldBasename = path.posix.basename(oldPathKey);
  const basenameMatches = oldFilePaths.filter(
    (candidate) => path.posix.basename(stripMarkdownExtension(candidate)).toLocaleLowerCase() === oldBasename,
  );
  const oldFilePathSet = new Set(oldFilePaths.map((candidate) => candidate.toLocaleLowerCase()));
  const sourceOldDirectory = path.posix.dirname(sourceOldPath);
  const sourceCurrentDirectory = path.posix.dirname(sourceCurrentPath);
  let changed = false;

  const mapWikiResolvedPath = (resolved: string) => {
    const normalized = stripMarkdownExtension(resolved).replace(/^\/+/, "");
    const normalizedLower = normalized.toLocaleLowerCase();
    if (kind === "file") {
      return normalizedLower === oldPathKey ? stripMarkdownExtension(nextPath) : null;
    }
    const oldFolder = oldPath.replace(/\/+$/, "");
    const oldFolderLower = oldFolder.toLocaleLowerCase();
    if (normalizedLower === oldFolderLower) return nextPath;
    if (!normalizedLower.startsWith(`${oldFolderLower}/`)) return null;
    return `${nextPath}${normalized.slice(oldFolder.length)}`;
  };

  const mapFilePath = (resolved: string) => {
    const normalized = path.posix.normalize(resolved.replace(/^\/+/, ""));
    const normalizedLower = normalized.toLocaleLowerCase();
    if (kind === "file") {
      return normalizedLower === oldPath.toLocaleLowerCase() ? nextPath : null;
    }
    const oldFolder = oldPath.replace(/\/+$/, "");
    const oldFolderLower = oldFolder.toLocaleLowerCase();
    if (normalizedLower === oldFolderLower) return nextPath;
    if (!normalizedLower.startsWith(`${oldFolderLower}/`)) return null;
    return `${nextPath}${normalized.slice(oldFolder.length)}`;
  };

  const rewriteWikiLinks = (part: string) =>
    part.replace(WIKI_LINK_RE, (match, embed: string, inner: string) => {
      const pipeIndex = inner.indexOf("|");
      const coreWithFragment = pipeIndex >= 0 ? inner.slice(0, pipeIndex) : inner;
      const aliasSuffix = pipeIndex >= 0 ? inner.slice(pipeIndex) : "";
      const hashIndex = coreWithFragment.indexOf("#");
      const rawTarget = (hashIndex >= 0 ? coreWithFragment.slice(0, hashIndex) : coreWithFragment).trim();
      const fragmentSuffix = hashIndex >= 0 ? coreWithFragment.slice(hashIndex) : "";
      if (!rawTarget) return match;

      const decodedTarget = decodeLoose(rawTarget).replace(/\\/g, "/").replace(/^\/+/, "");
      const targetWithoutExt = stripMarkdownExtension(decodedTarget);
      const candidates = [
        targetWithoutExt,
        path.posix.normalize(
          path.posix.join(sourceOldDirectory === "." ? "" : sourceOldDirectory, targetWithoutExt),
        ),
      ];
      if (!targetWithoutExt.includes("/") && basenameMatches.length === 1) {
        candidates.push(stripMarkdownExtension(basenameMatches[0]));
      }

      let mapped: string | null = null;
      for (const candidate of candidates) {
        mapped = mapWikiResolvedPath(candidate);
        if (mapped) break;
      }
      if (!mapped) return match;

      const usedPath = decodedTarget.includes("/") || kind === "folder";
      const nextTargetBase = usedPath ? mapped : path.posix.basename(mapped);
      const mappedMarkdownFile = kind === "file"
        ? /\.md$/i.test(nextPath)
        : /\.md$/i.test(rawTarget);
      const nextTarget = mappedMarkdownFile && /\.md$/i.test(rawTarget)
        ? `${stripMarkdownExtension(nextTargetBase)}.md`
        : nextTargetBase;
      changed = true;
      return `${embed}[[${nextTarget}${fragmentSuffix}${aliasSuffix}]]`;
    });

  const rewriteMarkdownLinks = (part: string) =>
    part.replace(
      /(?<!!)(\[[^\]]*\]\()(<[^>\n]+>|[^)\s]+)(\s+(?:"[^"]*"|'[^']*'))?(\))/g,
      (
        match,
        prefix: string,
        rawDestination: string,
        titleSuffix = "",
        close: string,
      ) => {
        const wrapped = rawDestination.startsWith("<") && rawDestination.endsWith(">");
        const href = wrapped ? rawDestination.slice(1, -1) : rawDestination;
        if (!href || href.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) {
          return match;
        }

        const suffixIndexCandidates = [href.indexOf("#"), href.indexOf("?")].filter((index) => index >= 0);
        const suffixIndex = suffixIndexCandidates.length > 0 ? Math.min(...suffixIndexCandidates) : -1;
        const rawTarget = suffixIndex >= 0 ? href.slice(0, suffixIndex) : href;
        const hrefSuffix = suffixIndex >= 0 ? href.slice(suffixIndex) : "";
        const decodedTarget = decodeLoose(rawTarget).replace(/\\/g, "/");
        const rootRelative = decodedTarget.startsWith("/");
        const resolvedOldTarget = path.posix.normalize(
          rootRelative
            ? decodedTarget.replace(/^\/+/, "")
            : path.posix.join(
                sourceOldDirectory === "." ? "" : sourceOldDirectory,
                decodedTarget,
              ),
        );

        if (!oldFilePathSet.has(resolvedOldTarget.toLocaleLowerCase())) return match;
        const mappedTarget = mapFilePath(resolvedOldTarget) ?? resolvedOldTarget;
        const sourceMoved = sourceOldDirectory !== sourceCurrentDirectory;
        if (!sourceMoved && mappedTarget === resolvedOldTarget) return match;

        let nextTarget = rootRelative
          ? `/${mappedTarget}`
          : path.posix.relative(
              sourceCurrentDirectory === "." ? "" : sourceCurrentDirectory,
              mappedTarget,
            );
        if (!nextTarget) nextTarget = path.posix.basename(mappedTarget);
        if (!rootRelative && decodedTarget.startsWith("./") && !nextTarget.startsWith(".")) {
          nextTarget = `./${nextTarget}`;
        }
        nextTarget = wrapped
          ? nextTarget.replace(/#/g, "%23").replace(/\?/g, "%3F")
          : encodeURI(nextTarget).replace(/#/g, "%23").replace(/\?/g, "%3F");

        const destination = wrapped ? `<${nextTarget}${hrefSuffix}>` : `${nextTarget}${hrefSuffix}`;
        if (destination === rawDestination) return match;
        changed = true;
        return `${prefix}${destination}${titleSuffix}${close}`;
      },
    );

  const rewritePart = (part: string) =>
    transformOutsideInlineCode(part, (plainText) =>
      rewriteMarkdownLinks(rewriteWikiLinks(plainText)));

  const fencedBlockPattern = /(```[\s\S]*?```|~~~[\s\S]*?~~~)/g;
  const nextContent = content
    .split(fencedBlockPattern)
    .map((part, index) => index % 2 === 1 ? part : rewritePart(part))
    .join("");
  return { content: nextContent, changed };
};

const updateWikiLinksAfterRename = async (
  vaultRoot: string,
  oldPath: string,
  nextPath: string,
  kind: "file" | "folder",
  oldFilePaths: string[],
) => {
  const tree = await walkDirectory(vaultRoot, "");
  const currentMarkdownPaths: string[] = [];
  const collect = (node: NotesTreeNode) => {
    if (node.type === "file" && /\.md$/i.test(node.path)) {
      currentMarkdownPaths.push(node.path);
    } else if (node.type === "directory") {
      for (const child of node.children) collect(child);
    }
  };
  collect(tree);

  let updatedFiles = 0;
  for (const currentPath of currentMarkdownPaths) {
    const sourceOldPath = kind === "folder" && currentPath.startsWith(`${nextPath}/`)
      ? `${oldPath}${currentPath.slice(nextPath.length)}`
      : currentPath === nextPath
        ? oldPath
        : currentPath;
    const absolutePath = path.join(vaultRoot, currentPath.replace(/\//g, path.sep));
    try {
      const content = await fs.readFile(absolutePath, "utf8");
      const rewritten = rewriteWikiLinksForRename(
        content,
        sourceOldPath,
        currentPath,
        oldPath,
        nextPath,
        kind,
        oldFilePaths,
      );
      if (rewritten.changed) {
        await fs.writeFile(absolutePath, rewritten.content, "utf8");
        updatedFiles++;
      }
    } catch {
      // A broken/unreadable note should not roll back an otherwise successful rename.
    }
  }
  return updatedFiles;
};

export const renameVaultEntry = async (
  relativePath: string,
  nextName: string,
  expectedKind?: "file" | "folder",
) => {
  const { absolutePath, relativePath: resolvedPath } = await resolveExistingVaultPath(relativePath);
  const stat = await fs.stat(absolutePath);
  if (!stat.isFile() && !stat.isDirectory()) {
    throw new VaultAccessError("Only files and folders can be renamed.", 400);
  }
  const actualKind = stat.isDirectory() ? "folder" : "file";
  if (expectedKind && actualKind !== expectedKind) {
    throw new VaultAccessError(
      expectedKind === "file" ? "Only files can be renamed here." : "Only folders can be renamed here.",
      400,
    );
  }

  const cleanName = sanitizeNameSegment(nextName);
  if (stat.isFile() && !isNoteFile(cleanName)) {
    throw new VaultAccessError("Only Markdown, HTML, PDF, and image files can be renamed.", 415);
  }

  if (stat.isDirectory() && !resolvedPath) {
    throw new VaultAccessError("The root folder cannot be renamed.", 400);
  }

  const vaultRoot = await getVaultRoot();
  const parentPath = path.posix.dirname(resolvedPath);
  const nextRelativePath = parentPath === "." ? cleanName : `${parentPath}/${cleanName}`;
  const nextAbsolutePath = path.resolve(vaultRoot, nextRelativePath);
  assertInsideVault(nextAbsolutePath, vaultRoot);

  try {
    await fs.access(nextAbsolutePath);
    throw new VaultAccessError("A file or folder with this name already exists.", 409);
  } catch (err) {
    if (err instanceof VaultAccessError) throw err;
  }

  const oldTree = await walkDirectory(vaultRoot, "");
  const oldFilePaths: string[] = [];
  const collectOldFiles = (node: NotesTreeNode) => {
    if (node.type === "file") {
      oldFilePaths.push(node.path);
    } else if (node.type === "directory") {
      for (const child of node.children) collectOldFiles(child);
    }
  };
  collectOldFiles(oldTree);

  await fs.rename(absolutePath, nextAbsolutePath);
  const updatedLinks = await updateWikiLinksAfterRename(
    vaultRoot,
    resolvedPath,
    nextRelativePath,
    actualKind,
    oldFilePaths,
  );
  return {
    oldPath: resolvedPath,
    path: nextRelativePath,
    name: cleanName,
    kind: actualKind,
    updatedLinks,
  };
};

export const deleteNote = async (relativePath: string) => {
  const { absolutePath, relativePath: resolvedPath } = await resolveExistingVaultPath(relativePath);

  const stat = await fs.stat(absolutePath);
  if (!stat.isFile()) {
    throw new VaultAccessError("Only files can be deleted.", 400);
  }

  await fs.unlink(absolutePath);
  return { path: resolvedPath };
};

export const deleteFolder = async (relativePath: string) => {
  const { absolutePath, relativePath: resolvedPath } = await resolveExistingVaultPath(relativePath);

  if (!resolvedPath) {
    throw new VaultAccessError("The root folder cannot be deleted.", 400);
  }

  const stat = await fs.stat(absolutePath);
  if (!stat.isDirectory()) {
    throw new VaultAccessError("Only folders can be deleted.", 400);
  }

  await fs.rm(absolutePath, { recursive: true, force: false });
  return { path: resolvedPath };
};

export const createFolder = async (relativePath: string) => {
  const sanitized = sanitizeRelativePath(relativePath);

  const vaultRoot = await getVaultRoot();
  const absolutePath = path.resolve(vaultRoot, sanitized);
  assertInsideVault(absolutePath, vaultRoot);

  // Refuse to create if path already exists
  try {
    await fs.access(absolutePath);
    throw new VaultAccessError("A folder with this name already exists.", 409);
  } catch (err) {
    if (err instanceof VaultAccessError) throw err;
    // ENOENT → doesn't exist yet, which is what we want
  }

  await fs.mkdir(absolutePath, { recursive: true });

  // Write a .gitkeep so the empty folder can be tracked by git and therefore
  // shows up in the sync tab. git cannot track empty directories on its own.
  // The git status API collapses a lone .gitkeep back into a folder entry, and
  // drops it once the folder holds a real note. (see GET handler in api/notes/git)
  const keepFile = path.join(absolutePath, ".gitkeep");
  await fs.writeFile(keepFile, "", "utf8");

  return { path: sanitized, name: path.posix.basename(sanitized) };
};

export const importVaultFiles = async (
  targetFolder: string,
  files: Array<{ name: string; data: Uint8Array }>,
) => {
  const sanitizedFolder = sanitizeRelativePath(targetFolder, { allowEmpty: true });
  const vaultRoot = await getVaultRoot();
  const targetAbsolutePath = path.resolve(vaultRoot, sanitizedFolder);
  assertInsideVault(targetAbsolutePath, vaultRoot);

  const targetStat = await fs.stat(targetAbsolutePath).catch(() => null);
  if (!targetStat?.isDirectory()) {
    throw new VaultAccessError("Target folder not found.", 404);
  }

  const imported: Array<{ path: string; name: string; size: number }> = [];
  const failed: Array<{ name: string; reason: string }> = [];
  for (const file of files) {
    // 单个文件出错时只记录、不中断，让其余文件继续导入。
    try {
      const cleanName = sanitizeNameSegment(path.basename(file.name));
      if (!isNoteFile(cleanName)) {
        throw new VaultAccessError("仅支持 Markdown、HTML、PDF 和图片文件。", 415);
      }

      const relativePath = sanitizedFolder ? `${sanitizedFolder}/${cleanName}` : cleanName;
      const absolutePath = path.resolve(vaultRoot, relativePath);
      assertInsideVault(absolutePath, vaultRoot);

      const exists = await fs.access(absolutePath).then(() => true).catch(() => false);
      if (exists) {
        throw new VaultAccessError(`“${cleanName}”已存在。`, 409);
      }

      await fs.writeFile(absolutePath, file.data);
      imported.push({ path: relativePath, name: cleanName, size: file.data.byteLength });
    } catch (err) {
      const reason = err instanceof VaultAccessError ? err.message : "写入失败。";
      failed.push({ name: file.name, reason });
    }
  }

  return { files: imported, failed };
};

export type WikiBacklinkEntry = {
  sourcePath: string;
  sourceName: string;
  context: string;
};

export type WikiIndexEntry = {
  path: string;
  aliases: string[];
};

const WIKI_LINK_RE = /(!?)\[\[([^\]]+)\]\]/g;
const MEDIA_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif|mp4|webm|mov|mp3|wav|ogg|flac|pdf)$/i;

const normalizeWikiTargetKey = (target: string) => {
  const normalized = target.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
  return normalized.endsWith(".md") ? normalized.slice(0, -3) : normalized;
};

const extractFrontMatterAliases = (content: string): string[] => {
  if (!content.startsWith("---")) return [];
  const firstNewline = content.indexOf("\n");
  if (firstNewline === -1) return [];
  const rest = content.slice(firstNewline + 1);
  const closing = /^---[ \t]*\r?$/m.exec(rest);
  if (!closing || closing.index === undefined) return [];
  const frontMatter = rest.slice(0, closing.index);
  const lines = frontMatter.split("\n");
  const aliases: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^\s*(aliases?|别名)\s*:\s*(.*)$/i);
    if (!match) continue;
    const inline = match[2].trim();
    if (inline.startsWith("[") && inline.endsWith("]")) {
      aliases.push(...inline.slice(1, -1).split(","));
      continue;
    }
    if (inline) {
      aliases.push(inline);
      continue;
    }
    while (i + 1 < lines.length && /^\s+-\s+/.test(lines[i + 1])) {
      aliases.push(lines[++i].replace(/^\s+-\s+/, ""));
    }
  }

  return [...new Set(aliases
    .map((alias) => alias.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean))];
};

const buildWikiIndex = async (
  vaultRoot: string,
  tree: NotesDirectoryNode,
): Promise<WikiIndexEntry[]> => {
  const markdownPaths: string[] = [];
  const collectMarkdown = (node: NotesTreeNode) => {
    if (node.type === "file" && /\.md$/i.test(node.path)) {
      markdownPaths.push(node.path);
    } else if (node.type === "directory") {
      for (const child of node.children) collectMarkdown(child);
    }
  };
  collectMarkdown(tree);

  // 限制并发，避免大型 vault 同时打开成千上万文件触发 EMFILE。此函数会在文件树
  // 每次变化时被调用，无上限的 Promise.all 在小内存机上风险尤其高。
  const entries: WikiIndexEntry[] = new Array(markdownPaths.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < markdownPaths.length) {
      const index = cursor++;
      const notePath = markdownPaths[index];
      try {
        const content = await fs.readFile(path.join(vaultRoot, notePath.replace(/\//g, path.sep)), "utf8");
        entries[index] = { path: notePath, aliases: extractFrontMatterAliases(content) };
      } catch {
        entries[index] = { path: notePath, aliases: [] };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(16, markdownPaths.length) }, () => worker()),
  );
  return entries;
};

export const getWikiIndex = async (): Promise<WikiIndexEntry[]> => {
  const vaultRoot = await getVaultRoot();
  const tree = await walkDirectory(vaultRoot, "");
  return buildWikiIndex(vaultRoot, tree);
};

const getMentionEntryKind = (relativePath: string): MentionEntryKind | null => {
  if (isMarkdownPath(relativePath)) return "markdown";
  if (isHtmlPath(relativePath)) return "html";
  if (isPdfPath(relativePath)) return "pdf";
  if (isImagePath(relativePath)) return "image";
  return null;
};

export const getMentionIndex = async (): Promise<MentionEntry[]> => {
  const vaultRoot = await getVaultRoot();
  const tree = await walkDirectory(vaultRoot, "");
  const aliasesByPath = new Map(
    (await buildWikiIndex(vaultRoot, tree)).map((entry) => [entry.path, entry.aliases]),
  );
  const entries: MentionEntry[] = [];

  const collectEntries = (node: NotesTreeNode) => {
    if (node.type === "directory") {
      for (const child of node.children) collectEntries(child);
      return;
    }

    const kind = getMentionEntryKind(node.path);
    if (!kind) return;
    const extension = path.posix.extname(node.name);
    entries.push({
      path: node.path,
      title: extension ? node.name.slice(0, -extension.length) : node.name,
      aliases: aliasesByPath.get(node.path) ?? [],
      kind,
    });
  };
  collectEntries(tree);

  return entries.sort((left, right) =>
    left.title.localeCompare(right.title, "zh-Hans", { numeric: true, sensitivity: "base" }) ||
    left.path.localeCompare(right.path, "zh-Hans", { numeric: true, sensitivity: "base" }),
  );
};

export const scanWikiBacklinks = async (targetRelPath: string): Promise<WikiBacklinkEntry[]> => {
  const normTarget = sanitizeRelativePath(targetRelPath);
  const vaultRoot = await getVaultRoot();
  const tree = await walkDirectory(vaultRoot, "");

  const allMdPaths: string[] = [];
  const collectMd = (node: NotesTreeNode) => {
    if (node.type === "file" && /\.md$/i.test(node.path)) {
      allMdPaths.push(node.path);
    } else if (node.type === "directory") {
      for (const child of node.children) collectMd(child);
    }
  };
  collectMd(tree);

  const noteStem = path.basename(normTarget, ".md").toLowerCase();
  const pathKey = normTarget.toLowerCase().endsWith(".md")
    ? normTarget.toLowerCase().slice(0, -3)
    : normTarget.toLowerCase();
  const targetAliases = await fs.readFile(path.join(vaultRoot, normTarget.replace(/\//g, path.sep)), "utf8")
    .then(extractFrontMatterAliases)
    .catch(() => []);
  const targetKeys = new Set([noteStem, pathKey, ...targetAliases.map(normalizeWikiTargetKey)]);

  const results: WikiBacklinkEntry[] = [];

  for (const mdPath of allMdPaths) {
    if (mdPath === normTarget) continue; // skip self

    const absPath = path.join(vaultRoot, mdPath.replace(/\//g, path.sep));
    let content: string;
    try {
      content = await fs.readFile(absPath, "utf8");
    } catch {
      continue;
    }

    // Two-pass fence stripping: only lines inside completed fence pairs are excluded.
    // Unclosed fences are treated as plain text (avoids silently losing content).
    const lines = content.split("\n");
    const codeLineSet = new Set<number>();
    let fStart = -1, fChar = "", fLen = 0;
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (fStart === -1) {
        const m = t.match(/^(`{3,}|~{3,})/);
        if (m) { fStart = i; fChar = m[1][0]; fLen = m[1].length; }
      } else {
        const m = t.match(/^(`{3,}|~{3,})\s*$/);
        if (m && m[1][0] === fChar && m[1].length >= fLen) {
          for (let j = fStart; j <= i; j++) codeLineSet.add(j);
          fStart = -1;
        }
      }
    }
    const clean = maskInlineCode(
      lines.map((line, i) => (codeLineSet.has(i) ? "" : line)).join("\n") + "\n",
    );
    const contextForIndex = (matchStart: number) => {
      const lineStart = clean.lastIndexOf("\n", matchStart - 1) + 1;
      const lineEnd = clean.indexOf("\n", matchStart);
      return clean.slice(lineStart, lineEnd === -1 ? clean.length : lineEnd).trim().slice(0, 120);
    };

    WIKI_LINK_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    let foundContext: string | null = null;
    while ((match = WIKI_LINK_RE.exec(clean)) !== null) {
      const [, embedBang, inner] = match;
      const isEmbed = embedBang === "!";
      const targetRaw = inner.split("|")[0].split("#")[0].trim().toLowerCase();
      if (isEmbed && MEDIA_EXT_RE.test(targetRaw)) continue;
      const targetKey = normalizeWikiTargetKey(targetRaw);
      if (!targetKeys.has(targetKey)) continue;
      foundContext = contextForIndex(match.index);
      break;
    }

    // Standard Markdown links to .md files also count as backlinks in Obsidian.
    if (!foundContext) {
      const markdownLinkRe = /(?<!!)\[[^\]]*\]\((<?[^)\s>]+>?)(?:\s+["'][^"']*["'])?\)/g;
      let markdownMatch: RegExpExecArray | null;
      while ((markdownMatch = markdownLinkRe.exec(clean)) !== null) {
        const href = decodeLoose(markdownMatch[1].replace(/^<|>$/g, ""));
        if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) continue;
        const target = href.split("#")[0].replace(/\\/g, "/");
        if (!/\.md$/i.test(target)) continue;
        const sourceDirectory = path.posix.dirname(mdPath);
        const candidates = [
          normalizeWikiTargetKey(target),
          normalizeWikiTargetKey(path.posix.normalize(path.posix.join(sourceDirectory === "." ? "" : sourceDirectory, target))),
        ];
        if (!candidates.includes(pathKey)) continue;
        foundContext = contextForIndex(markdownMatch.index);
        break;
      }
    }

    if (foundContext) {
      results.push({
        sourcePath: mdPath,
        sourceName: path.basename(mdPath, ".md"),
        context: foundContext,
      });
    }
  }

  return results;
};

export const mapVaultError = (error: unknown) => {
  if (error instanceof VaultAccessError) {
    return {
      message: error.message,
      status: error.status,
    };
  }

  console.error(error);
  return {
    message: "Unexpected notes vault error.",
    status: 500,
  };
};
