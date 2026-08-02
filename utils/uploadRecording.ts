import { WORKERS_API_URL } from "./config";

export interface UploadRecordingOptions {
    blob: Blob;
    userName: string;
    /** リトライしても同じファイルとして扱われるようにするための識別子 */
    uploadId: string;
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
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await sendOnce(options);
        } catch (e) {
            lastError = e;

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

function sendOnce(options: UploadRecordingOptions): Promise<UploadRecordingResult> {
    const { blob, userName, uploadId, onProgress } = options;

    return new Promise<UploadRecordingResult>((resolve, reject) => {
        const url =
            `${WORKERS_API_URL}/upload` +
            `?name=${encodeURIComponent(userName)}` +
            `&id=${encodeURIComponent(uploadId)}`;

        const xhr = new XMLHttpRequest();
        xhr.open("POST", url, true);
        xhr.responseType = "text";
        xhr.timeout = ATTEMPT_TIMEOUT_MS;
        xhr.setRequestHeader("Content-Type", "audio/wav");

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

        xhr.send(blob);
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
