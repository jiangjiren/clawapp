// 文件树与阅读区共用的路径/类型小工具（从 NotesExplorer 渐进拆分而来）

export type TreeActionTarget = {
  kind: "file" | "folder";
  name: string;
  path: string;
};

export const stripNoteExtension = (value: string) => value.replace(/\.(md|html?)$/i, "");

// PDF / 图片走只读预览，不经文本加载/编辑流程
export const isPdfPath = (value: string | null | undefined) => /\.pdf$/i.test(value ?? "");
export const isImagePath = (value: string | null | undefined) =>
  /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(value ?? "");

export type FileKind =
  | "note"
  | "doc"
  | "image"
  | "code"
  | "pdf"
  | "sheet"
  | "audio"
  | "video"
  | "archive";

const FILE_KIND_BY_EXT: Record<string, FileKind> = {
  md: "note", markdown: "note", txt: "note", rtf: "note", doc: "doc", docx: "doc",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", svg: "image",
  bmp: "image", avif: "image", ico: "image", heic: "image",
  html: "code", htm: "code", js: "code", mjs: "code", cjs: "code", ts: "code", tsx: "code",
  jsx: "code", css: "code", scss: "code", json: "code", yaml: "code", yml: "code",
  toml: "code", xml: "code", py: "code", rs: "code", go: "code", java: "code", c: "code",
  h: "code", cpp: "code", sh: "code", rb: "code", php: "code", sql: "code", vue: "code", svelte: "code",
  pdf: "pdf",
  csv: "sheet", xls: "sheet", xlsx: "sheet",
  mp3: "audio", wav: "audio", m4a: "audio", flac: "audio", ogg: "audio", aac: "audio",
  mp4: "video", mov: "video", mkv: "video", avi: "video", webm: "video",
  zip: "archive", rar: "archive", "7z": "archive", gz: "archive", tar: "archive", bz2: "archive",
};

// 点开头的隐藏文件（.gitignore）整体当文件名，不拆扩展名
export const fileExtensionOf = (value: string) => {
  const match = /.+\.([^.]+)$/.exec(value);
  return match ? match[1].toLowerCase() : "";
};

// 认不出的扩展名退回中性文档图标，宁可不着色也不误导
export const fileKindOf = (ext: string): FileKind => FILE_KIND_BY_EXT[ext] ?? "doc";
