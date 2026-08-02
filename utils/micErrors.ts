import type { DeviceType } from "./environment";

export type MicErrorAction = "retry" | "externalBrowser" | "none";

export interface MicErrorInfo {
    /** DOMException.name 等。ユーザーが問い合わせるときの手がかりとして画面に小さく出す */
    code: string;
    title: string;
    message: string;
    /** 端末別の具体的な対処手順 */
    hints: string[];
    action: MicErrorAction;
}

function deviceHints(device: DeviceType): string[] {
    if (device === "ios") {
        return [
            "設定 → Safari → マイク → 「確認」または「許可」",
            "設定 → Safari → 「Webサイトの設定」でこのサイトのマイクを許可",
        ];
    }
    if (device === "android") {
        return [
            "アドレスバー左の 🔒 → 「権限」→ マイクを許可",
            "設定 → アプリ → Chrome → 権限 → マイク → 許可",
        ];
    }
    return [
        "アドレスバー左の 🔒 アイコンをクリック",
        "「マイク」を「許可」に変更してページを再読み込み",
    ];
}

/**
 * getUserMedia 由来の例外を、ユーザーが実際に行動できる日本語メッセージに変換する。
 * 従来はすべて「マイクへのアクセスが許可されていません」に丸められていたため、
 * 権限とは無関係な失敗（非対応ブラウザ・マイク使用中など）で詰んでいた。
 */
export function describeMicError(error: unknown, device: DeviceType): MicErrorInfo {
    const name =
        error instanceof DOMException || (error instanceof Error && error.name)
            ? error.name
            : "UnknownError";

    // navigator.mediaDevices が存在しない環境では TypeError になる
    if (error instanceof TypeError || name === "TypeError") {
        return {
            code: "Unsupported",
            title: "このブラウザでは録音できません",
            message:
                "お使いのブラウザはマイク録音に対応していません。Safari または Chrome で開き直してください。",
            hints: [],
            action: "externalBrowser",
        };
    }

    switch (name) {
        case "NotAllowedError":
        case "PermissionDeniedError":
            return {
                code: name,
                title: "マイクの使用が許可されませんでした",
                message:
                    "録音するにはマイクの許可が必要です。下の手順で許可してから、もう一度お試しください。",
                hints: deviceHints(device),
                action: "retry",
            };

        case "NotFoundError":
        case "DevicesNotFoundError":
            return {
                code: name,
                title: "マイクが見つかりません",
                message:
                    "使用できるマイクが検出できませんでした。イヤホンやヘッドセットを外して、本体のマイクでお試しください。",
                hints: ["Bluetoothイヤホンを接続している場合は切断してください"],
                action: "retry",
            };

        case "NotReadableError":
        case "TrackStartError":
        case "AbortError":
            return {
                code: name,
                title: "マイクが使用中です",
                message:
                    "他のアプリがマイクを使用しているため録音できません。通話アプリやボイスメモなどを終了してから、もう一度お試しください。",
                hints: [
                    "通話中・録音中のアプリを終了する",
                    "他のタブでこのサイトを開いていないか確認する",
                ],
                action: "retry",
            };

        case "SecurityError":
            return {
                code: name,
                title: "安全な接続で開いてください",
                message:
                    "マイクを使うには https:// で始まるURLでアクセスする必要があります。",
                hints: [],
                action: "none",
            };

        case "OverconstrainedError":
        case "ConstraintNotSatisfiedError":
            return {
                code: name,
                title: "マイクの設定に対応していません",
                message:
                    "お使いのマイクがこの録音設定に対応していませんでした。もう一度お試しください。",
                hints: [],
                action: "retry",
            };

        default:
            return {
                code: name,
                title: "録音を開始できませんでした",
                message:
                    "予期しないエラーが発生しました。ページを再読み込みして、もう一度お試しください。",
                hints: [],
                action: "retry",
            };
    }
}
