/**
 * 声紋分析レコーダー - Cloudflare Workers API
 * 
 * R2に音声ファイルを保存し、管理画面から一覧・ダウンロード・削除できるAPIを提供
 */

export interface Env {
    RECORDINGS: R2Bucket;
    ADMIN_PASSWORD: string;
    GAS_WEB_APP_URL: string;
}

// CORS ヘッダー
const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// 認証チェック
function checkAuth(request: Request, env: Env): boolean {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return false;
    }
    const token = authHeader.slice(7);
    return token === env.ADMIN_PASSWORD;
}

// エラーレスポンス
function errorResponse(message: string, status: number): Response {
    return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
}

// 成功レスポンス
function jsonResponse(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);
        const path = url.pathname;

        // CORS プリフライト
        if (request.method === "OPTIONS") {
            return new Response(null, { headers: corsHeaders });
        }

        try {
            // ============ アップロード（認証不要） ============
            if (request.method === "POST" && path === "/upload") {
                const body = await request.json() as {
                    fileData: string;
                    mimeType: string;
                    userName: string;
                };

                if (!body.fileData || !body.userName) {
                    return errorResponse("fileDataとuserNameは必須です", 400);
                }

                // Base64デコード
                const base64Data = body.fileData.replace(/^data:audio\/\w+;base64,/, "");
                const binaryData = Uint8Array.from(atob(base64Data), (c) => c.charCodeAt(0));

                // ファイル名生成（タイムスタンプ付き）
                const date = new Date();
                const timestamp = date.toISOString().replace(/[:.]/g, "-");
                const fileName = `${body.userName}_${timestamp}.wav`;
                const formattedDate = date.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });

                // R2に保存
                await env.RECORDINGS.put(fileName, binaryData, {
                    httpMetadata: {
                        contentType: body.mimeType || "audio/wav",
                    },
                    customMetadata: {
                        userName: body.userName,
                        uploadedAt: date.toISOString(),
                    },
                });

                // メール通知 (GAS経由)
                if (env.GAS_WEB_APP_URL) {
                    try {
                        const notifyResponse = await fetch(env.GAS_WEB_APP_URL, {
                            method: "POST",
                            headers: {
                                "Content-Type": "application/json",
                            },
                            body: JSON.stringify({
                                type: "notification",
                                userName: body.userName,
                                fileName: fileName,
                                uploadedAt: formattedDate,
                            }),
                            redirect: "follow", // GASのリダイレクトを追跡
                        });

                        if (!notifyResponse.ok) {
                            console.error("Failed to call GAS:", notifyResponse.statusText);
                        }
                    } catch (notifyError) {
                        console.error("GAS notification error:", notifyError);
                    }
                }

                return jsonResponse({ result: "success", fileName });
            }

            // ============ 以下は認証必要 ============

            // ファイル一覧取得
            if (request.method === "GET" && path === "/list") {
                if (!checkAuth(request, env)) {
                    return errorResponse("認証が必要です", 401);
                }

                const list = await env.RECORDINGS.list();
                const files = list.objects.map((obj: { key: string; size: number; uploaded: Date }) => ({
                    name: obj.key,
                    size: obj.size,
                    uploaded: obj.uploaded.toISOString(),
                }));

                return jsonResponse({ files });
            }

            // ファイルダウンロード
            if (request.method === "GET" && path.startsWith("/download/")) {
                if (!checkAuth(request, env)) {
                    return errorResponse("認証が必要です", 401);
                }

                const fileName = decodeURIComponent(path.replace("/download/", ""));
                const object = await env.RECORDINGS.get(fileName);

                if (!object) {
                    return errorResponse("ファイルが見つかりません", 404);
                }

                const headers = new Headers(corsHeaders);
                headers.set("Content-Type", object.httpMetadata?.contentType || "audio/wav");
                headers.set("Content-Disposition", `attachment; filename="${fileName}"`);

                return new Response(object.body, { headers });
            }

            // ファイル削除
            if (request.method === "DELETE" && path.startsWith("/delete/")) {
                if (!checkAuth(request, env)) {
                    return errorResponse("認証が必要です", 401);
                }

                const fileName = decodeURIComponent(path.replace("/delete/", ""));
                await env.RECORDINGS.delete(fileName);

                return jsonResponse({ result: "success", deleted: fileName });
            }

            return errorResponse("エンドポイントが見つかりません", 404);

        } catch (e) {
            console.error("Error:", e);
            return errorResponse(`サーバーエラー: ${e instanceof Error ? e.message : "不明なエラー"}`, 500);
        }
    },
};
