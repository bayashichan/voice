import { WORKERS_API_URL } from "./config";

export interface UploadRecordingOptions {
    blob: Blob;
    userName: string;
    /** リトライしても同じファイルとして扱われるようにするための識別子 */
    uploadId: string;
    /**
     * 録音の付帯情報（形式・端末のサンプリングレート・音声処理の状態など）。
     * Worker が保存ファイルのメタデータとして残し、VoiceScan の一覧に表示する。
     * 旧 Worker は無視するだけなので互換性に影響しない。
     */
    meta?: Record<string, string>;
    /** 0..1 のアップロード進捗 */
    onProgress?: (ratio: number) => void;
    /** リトライ待機に入るたびに呼ばれる（1 始まり） */
    onRetry?: (attempt: number, maxAttempts: number) => void;
}

export interface UploadRecordingResult {
    fileName: string;
}

export class UploadError extends Error {
    readonly status: number;
    readonly retryable: boolean;

    constructor(message: string, status: number, retryable: boolean) {
        super(message);
        this.name = "UploadError";
        this.status = status;
        this.retryable = retryable;
    }
}

/** 1回あたりの上限。1MB弱のWAVをモバイル回線で送る想定で余裕を持たせる */
const ATTEMPT_TIMEOUT_MS = 45_000;
const RETRY_DELAYS_MS = [1_000, 3_000, 7_000];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 録音WAVをそのままバイナリでアップロードする。
 *
 * 以前は Base64 + JSON だったため転送量が約1.33倍になり、
 * 1MB超の文字列を JSON.stringify する時点で古いiPhoneが落ちていた
 * （履歴にある iOS の "fetch: Load failed"）。
 * ここでは Blob を直接送り、進捗・タイムアウト・リトライを付ける。
 */
export async function uploadRecording(
    options: UploadRecordingOptions
): Promise<UploadRecordingResult> {
    const maxAttempts = RETRY_DELAYS_MS.length + 1;
    let mode: UploadMode = "binary";
    let switchedToLegacy = false;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await sendOnce(options, mode);
        } catch (e) {
            lastError = e;

            // Pages と Workers は別々にデプロイされるため、まだ旧 Worker が
            // 動いている瞬間がありうる。旧 Worker はバイナリを受け取ると
            // request.json() で落ちて500を返すので、その場合だけ旧形式
            // （Base64+JSON）に切り替えて即座に送り直す。
            // これによりデプロイ順序が前後してもアップロードが全滅しない。
            if (
                mode === "binary" &&
                !switchedToLegacy &&
                e instanceof UploadError &&
                e.status === 500
            ) {
                switchedToLegacy = true;
                mode = "legacy";
                options.onProgress?.(0);
                continue;
            }

            const retryable = !(e instanceof UploadError) || e.retryable;
            if (!retryable || attempt === maxAttempts) break;

            options.onRetry?.(attempt, maxAttempts);
            options.onProgress?.(0);
            await sleep(RETRY_DELAYS_MS[attempt - 1]);
        }
    }

    throw lastError instanceof Error
        ? lastError
        : new UploadError("アップロードに失敗しました", 0, false);
}

type UploadMode = "binary" | "legacy";

/** 旧 Worker 向けフォールバック用。Blob を Base64 文字列にする。 */
function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            const result = reader.result as string;
            const comma = result.indexOf(",");
            resolve(comma >= 0 ? result.slice(comma + 1) : result);
        };
        reader.onerror = () => reject(new UploadError("データ変換に失敗しました", 0, false));
        reader.readAsDataURL(blob);
    });
}

async function sendOnce(
    options: UploadRecordingOptions,
    mode: UploadMode
): Promise<UploadRecordingResult> {
    const { blob, userName, uploadId, meta, onProgress } = options;

    let body: Blob | string;
    let contentType: string;

    if (mode === "legacy") {
        contentType = "application/json";
        body = JSON.stringify({
            fileData: await blobToBase64(blob),
            mimeType: "audio/wav",
            userName,
            uploadId,
        });
    } else {
        contentType = "audio/wav";
        body = blob;
    }

    return new Promise<UploadRecordingResult>((resolve, reject) => {
        const params = new URLSearchParams({ name: userName, id: uploadId });
        for (const [key, value] of Object.entries(meta ?? {})) params.set(key, value);
        const url = `${WORKERS_API_URL}/upload?${params.toString()}`;

        const xhr = new XMLHttpRequest();
        xhr.open("POST", url, true);
        xhr.responseType = "text";
        xhr.timeout = ATTEMPT_TIMEOUT_MS;
        xhr.setRequestHeader("Content-Type", contentType);

        xhr.upload.onprogress = (event) => {
            if (event.lengthComputable && event.total > 0) {
                onProgress?.(Math.min(1, event.loaded / event.total));
            }
        };

        xhr.onload = () => {
            const status = xhr.status;

            if (status >= 200 && status < 300) {
                try {
                    const json = JSON.parse(xhr.responseText) as {
                        result?: string;
                        fileName?: string;
                    };
                    if (json.result === "success" && json.fileName) {
                        onProgress?.(1);
                        resolve({ fileName: json.fileName });
                        return;
                    }
                    reject(new UploadError("サーバーの応答が不正です", status, true));
                } catch {
                    reject(new UploadError("サーバーの応答を解析できません", status, true));
                }
                return;
            }

            // 4xx はリクエスト側の問題なので再送しても無駄
            const retryable = status === 0 || status === 429 || status >= 500;
            reject(new UploadError(`アップロードに失敗しました (${status})`, status, retryable));
        };

        xhr.onerror = () => {
            reject(new UploadError("ネットワークエラー", 0, true));
        };
        xhr.ontimeout = () => {
            reject(new UploadError("タイムアウトしました", 0, true));
        };
        xhr.onabort = () => {
            reject(new UploadError("中断されました", 0, false));
        };

        xhr.send(body);
    });
}

export interface FailureReport {
    stage: string;
    errorName: string;
    userName: string;
    detail?: string;
}

/**
 * 失敗を運営に通知する（送信できなくても握りつぶす）。
 * これまでエラーの可視性がゼロで「エラーになる」の原因が追えなかったため追加。
 */
export function reportFailure(report: FailureReport): void {
    try {
        const body = JSON.stringify({
            ...report,
            userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
            url: typeof location !== "undefined" ? location.href : "",
        });

        // ページ遷移中でも届くよう keepalive 付きで投げる
        void fetch(`${WORKERS_API_URL}/report`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
            keepalive: true,
        }).catch(() => undefined);
    } catch {
        // 通知の失敗で本体のフローを止めない
    }
}
