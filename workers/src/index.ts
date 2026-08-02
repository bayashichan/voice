/**
 * 声紋分析レコーダー - Cloudflare Workers API
 *
 * R2に音声ファイルを保存し、管理画面から一覧・ダウンロード・削除できるAPIを提供
 */

export interface Env {
    RECORDINGS: R2Bucket;
    /** wrangler secret put ADMIN_PASSWORD で設定する */
    ADMIN_PASSWORD: string;
    /** wrangler secret put GAS_WEB_APP_URL で設定する（メール通知用・任意） */
    GAS_WEB_APP_URL: string;
}

/** 20MB。10秒/48kHz/16bitのWAVは約1MBなので十分な余裕 */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** アップロードIDと保存済みファイル名の対応を置くプレフィックス（一覧からは隠す） */
const ID_INDEX_PREFIX = "_ids/";

/** 管理APIを呼べるオリジン */
const ADMIN_ORIGIN_PATTERNS = [
    /^https:\/\/([a-z0-9-]+\.)?voice-recorder-aba\.pages\.dev$/i,
    /^http:\/\/localhost(:\d+)?$/i,
    /^http:\/\/127\.0\.0\.1(:\d+)?$/i,
];

// 誰でも呼べるエンドポイント（アップロード・失敗報告）用のCORSヘッダー
const publicCorsHeaders: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
};

function isAdminPath(path: string): boolean {
    return (
        path === "/list" ||
        path.startsWith("/download/") ||
        path.startsWith("/delete/")
    );
}

/** 管理APIは呼び出し元オリジンを限定する（Bearerトークンに加えた多層防御） */
function adminCorsHeaders(request: Request): Record<string, string> {
    const origin = request.headers.get("Origin");
    const headers: Record<string, string> = {
        "Access-Control-Allow-Methods": "GET, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400",
        Vary: "Origin",
    };
    if (origin && ADMIN_ORIGIN_PATTERNS.some((re) => re.test(origin))) {
        headers["Access-Control-Allow-Origin"] = origin;
    }
    return headers;
}

function corsHeadersFor(request: Request, path: string): Record<string, string> {
    return isAdminPath(path) ? adminCorsHeaders(request) : publicCorsHeaders;
}

// 認証チェック
function checkAuth(request: Request, env: Env): boolean {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return false;
    }
    const token = authHeader.slice(7);
    if (!env.ADMIN_PASSWORD || !token) return false;
    return token === env.ADMIN_PASSWORD;
}

function errorResponse(
    message: string,
    status: number,
    cors: Record<string, string>
): Response {
    return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { ...cors, "Content-Type": "application/json" },
    });
}

function jsonResponse(
    data: unknown,
    cors: Record<string, string>,
    status = 200
): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: { ...cors, "Content-Type": "application/json" },
    });
}

/**
 * R2キー・ファイル名として安全な名前にする。
 * パス区切りや制御文字が入ると保存も配信も壊れるため必ず通す。
 */
function sanitizeUserName(raw: string | null | undefined): string {
    if (!raw) return "unknown";
    const cleaned = raw
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .replace(/[\\/:*?"<>|]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 40);
    return cleaned.length > 0 ? cleaned : "unknown";
}

/** 非ASCIIを含むファイル名でもヘッダーに載せられる形式にする（RFC 5987） */
function contentDispositionFor(fileName: string): string {
    const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "");
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function base64ToBytes(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

/** GAS経由でメール通知する。失敗しても本処理には影響させない。 */
async function notifyByEmail(
    env: Env,
    payload: { userName: string; fileName: string; uploadedAt: string }
): Promise<void> {
    if (!env.GAS_WEB_APP_URL) return;
    try {
        const res = await fetch(env.GAS_WEB_APP_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "notification", ...payload }),
            redirect: "follow", // GASのリダイレクトを追跡
        });
        if (!res.ok) {
            console.error("Failed to call GAS:", res.status, res.statusText);
        }
    } catch (e) {
        console.error("GAS notification error:", e);
    }
}

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);
        const path = url.pathname;
        const cors = corsHeadersFor(request, path);

        // CORS プリフライト
        if (request.method === "OPTIONS") {
            return new Response(null, { headers: cors });
        }

        try {
            // ============ アップロード（認証不要） ============
            if (request.method === "POST" && path === "/upload") {
                return await handleUpload(request, env, ctx, url, cors);
            }

            // ============ 失敗レポート（認証不要） ============
            if (request.method === "POST" && path === "/report") {
                return await handleReport(request, env, ctx, cors);
            }

            // ============ 以下は認証必要 ============

            // ファイル一覧取得
            if (request.method === "GET" && path === "/list") {
                if (!checkAuth(request, env)) {
                    return errorResponse("認証が必要です", 401, cors);
                }

                const list = await env.RECORDINGS.list();
                const files = list.objects
                    .filter((obj) => !obj.key.startsWith(ID_INDEX_PREFIX))
                    .map((obj) => ({
                        name: obj.key,
                        size: obj.size,
                        uploaded: obj.uploaded.toISOString(),
                    }));

                return jsonResponse({ files }, cors);
            }

            // ファイルダウンロード
            if (request.method === "GET" && path.startsWith("/download/")) {
                if (!checkAuth(request, env)) {
                    return errorResponse("認証が必要です", 401, cors);
                }

                const fileName = decodeURIComponent(path.replace("/download/", ""));
                if (fileName.startsWith(ID_INDEX_PREFIX)) {
                    return errorResponse("ファイルが見つかりません", 404, cors);
                }

                const object = await env.RECORDINGS.get(fileName);
                if (!object) {
                    return errorResponse("ファイルが見つかりません", 404, cors);
                }

                const headers = new Headers(cors);
                headers.set("Content-Type", object.httpMetadata?.contentType || "audio/wav");
                // 日本語名でもヘッダーに載せられる形式にする（従来はここで500になっていた）
                headers.set("Content-Disposition", contentDispositionFor(fileName));

                return new Response(object.body, { headers });
            }

            // ファイル削除
            if (request.method === "DELETE" && path.startsWith("/delete/")) {
                if (!checkAuth(request, env)) {
                    return errorResponse("認証が必要です", 401, cors);
                }

                const fileName = decodeURIComponent(path.replace("/delete/", ""));
                if (fileName.startsWith(ID_INDEX_PREFIX)) {
                    return errorResponse("ファイルが見つかりません", 404, cors);
                }
                await env.RECORDINGS.delete(fileName);

                return jsonResponse({ result: "success", deleted: fileName }, cors);
            }

            return errorResponse("エンドポイントが見つかりません", 404, cors);
        } catch (e) {
            console.error("Error:", e);
            return errorResponse(
                `サーバーエラー: ${e instanceof Error ? e.message : "不明なエラー"}`,
                500,
                cors
            );
        }
    },
};

async function handleUpload(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
    url: URL,
    cors: Record<string, string>
): Promise<Response> {
    const contentType = request.headers.get("Content-Type") || "";

    let bytes: Uint8Array;
    let userName: string;
    let uploadId: string | null;
    let mimeType = "audio/wav";

    if (contentType.includes("application/json")) {
        // 旧クライアント互換: Base64をJSONで受け取る経路。
        // 全クライアントが新形式に移行したら削除してよい。
        const body = (await request.json()) as {
            fileData?: string;
            mimeType?: string;
            userName?: string;
            uploadId?: string;
        };

        if (!body.fileData || !body.userName) {
            return errorResponse("fileDataとuserNameは必須です", 400, cors);
        }

        const base64Data = body.fileData.replace(/^data:audio\/\w+;base64,/, "");
        bytes = base64ToBytes(base64Data);
        userName = sanitizeUserName(body.userName);
        uploadId = body.uploadId ?? null;
        mimeType = body.mimeType || "audio/wav";
    } else {
        // 現行クライアント: WAVをそのままバイナリで受け取る
        userName = sanitizeUserName(url.searchParams.get("name"));
        uploadId = url.searchParams.get("id");
        mimeType = contentType || "audio/wav";

        const buffer = await request.arrayBuffer();
        bytes = new Uint8Array(buffer);
    }

    if (bytes.byteLength === 0) {
        return errorResponse("音声データが空です", 400, cors);
    }
    if (bytes.byteLength > MAX_UPLOAD_BYTES) {
        return errorResponse("音声データが大きすぎます", 413, cors);
    }
    // WAVヘッダーだけ（44バイト）のような明らかに壊れたデータは受け付けない
    if (bytes.byteLength <= 1024) {
        return errorResponse("録音データが短すぎます", 400, cors);
    }

    // 同じuploadIdで再送された場合は既存のファイル名を返し、重複保存を防ぐ
    if (uploadId) {
        const existing = await env.RECORDINGS.head(`${ID_INDEX_PREFIX}${uploadId}`);
        const known = existing?.customMetadata?.fileName;
        if (known) {
            return jsonResponse({ result: "success", fileName: known }, cors);
        }
    }

    const date = new Date();
    const timestamp = date.toISOString().replace(/[:.]/g, "-");
    const fileName = `${userName}_${timestamp}.wav`;
    const formattedDate = date.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });

    await env.RECORDINGS.put(fileName, bytes, {
        httpMetadata: { contentType: mimeType },
        customMetadata: {
            userName,
            uploadedAt: date.toISOString(),
        },
    });

    if (uploadId) {
        ctx.waitUntil(
            env.RECORDINGS.put(`${ID_INDEX_PREFIX}${uploadId}`, new Uint8Array(0), {
                customMetadata: { fileName },
            })
        );
    }

    // メール通知はレスポンスを待たせない。GASは数秒かかることがあり、
    // 以前はこれをawaitしていたためモバイルでタイムアウトしやすかった。
    ctx.waitUntil(notifyByEmail(env, { userName, fileName, uploadedAt: formattedDate }));

    return jsonResponse({ result: "success", fileName }, cors);
}

/**
 * クライアント側の失敗を運営に知らせる。
 * 既存のGAS通知をそのまま使うのでGAS側の改修は不要。
 */
async function handleReport(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
    cors: Record<string, string>
): Promise<Response> {
    let body: {
        stage?: string;
        errorName?: string;
        userName?: string;
        detail?: string;
        userAgent?: string;
        url?: string;
    };

    try {
        body = (await request.json()) as typeof body;
    } catch {
        return errorResponse("不正なリクエストです", 400, cors);
    }

    const stage = (body.stage || "unknown").slice(0, 60);
    const errorName = (body.errorName || "UnknownError").slice(0, 60);
    const userName = sanitizeUserName(body.userName);

    console.error("client failure:", { stage, errorName, userName, ua: body.userAgent });

    ctx.waitUntil(
        notifyByEmail(env, {
            userName: `【録音失敗】${userName}（${errorName}）`,
            fileName: `失敗箇所: ${stage} / ${(body.detail || "詳細なし").slice(0, 200)}`,
            uploadedAt: `${new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}\n■ 環境: ${(body.userAgent || "").slice(0, 300)}`,
        })
    );

    return jsonResponse({ result: "received" }, cors);
}
