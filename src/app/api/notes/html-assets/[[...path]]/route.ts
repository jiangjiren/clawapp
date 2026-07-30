import { NextResponse } from "next/server";
import { mapVaultError, readVaultHtmlAsset } from "@/lib/notesVault";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ path?: string[] }>;
};

// HTML srcdoc 通过 <base> 把相对资源映射到这里。使用 catch-all 路径而不是
// query 参数，确保 CSS 内的 url(...) 和 @import 还能继续按目录相对解析。
export async function GET(_request: Request, context: RouteContext) {
  const segments = (await context.params).path ?? [];
  const assetPath = segments.join("/");

  if (!assetPath) {
    return NextResponse.json({ error: "Missing HTML preview asset path." }, { status: 400 });
  }

  try {
    const asset = await readVaultHtmlAsset(assetPath);
    return new NextResponse(asset.body, {
      headers: {
        // HTML 预览会随文件 watcher 实时刷新；强缓存会让已修改的 CSS/JS
        // 继续显示旧版本，因此每次重载都向服务端确认。
        "cache-control": "private, no-cache",
        "content-length": String(asset.size),
        "content-type": asset.contentType,
        "last-modified": asset.updatedAt,
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    const mappedError = mapVaultError(error);
    return NextResponse.json({ error: mappedError.message }, { status: mappedError.status });
  }
}
