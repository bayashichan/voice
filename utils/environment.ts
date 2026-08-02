export type DeviceType = "ios" | "android" | "pc";

export type InAppBrowser = "line" | "instagram" | "facebook" | "twitter" | "tiktok" | null;

export interface EnvironmentInfo {
    device: DeviceType;
    /** アプリ内ブラウザ（WebView）で開かれている場合はその種別 */
    inAppBrowser: InAppBrowser;
    /** getUserMedia が実際に呼べる環境かどうか（UAではなく機能で判定） */
    canRecord: boolean;
    /** https（またはlocalhost）で開かれているか */
    isSecure: boolean;
}

function detectDevice(ua: string): DeviceType {
    if (/iphone|ipad|ipod/.test(ua)) return "ios";
    // iPadOS 13以降はデスクトップUAを名乗るのでタッチ有無で補正する
    if (/macintosh/.test(ua) && typeof navigator !== "undefined" && navigator.maxTouchPoints > 1) {
        return "ios";
    }
    if (/android/.test(ua)) return "android";
    return "pc";
}

function detectInAppBrowser(rawUa: string): InAppBrowser {
    // LINEの内蔵ブラウザは UA に " Line/13.x.x" を含む
    if (/\bline\//i.test(rawUa)) return "line";
    if (/instagram/i.test(rawUa)) return "instagram";
    if (/\bFBAN\b|\bFBAV\b|FB_IAB/i.test(rawUa)) return "facebook";
    if (/twitter/i.test(rawUa)) return "twitter";
    if (/musical_ly|bytedancewebview|tiktok/i.test(rawUa)) return "tiktok";
    return null;
}

export function detectEnvironment(): EnvironmentInfo {
    if (typeof navigator === "undefined" || typeof window === "undefined") {
        return { device: "pc", inAppBrowser: null, canRecord: true, isSecure: true };
    }

    const rawUa = navigator.userAgent;
    const ua = rawUa.toLowerCase();

    const isSecure = window.isSecureContext === true;
    const canRecord =
        isSecure && typeof navigator.mediaDevices?.getUserMedia === "function";

    return {
        device: detectDevice(ua),
        inAppBrowser: detectInAppBrowser(rawUa),
        canRecord,
        isSecure,
    };
}

/** アプリ内ブラウザから標準ブラウザへ移ってもらうための案内文 */
export function getExternalBrowserGuide(
    inAppBrowser: InAppBrowser,
    device: DeviceType
): { title: string; steps: string[] } {
    if (inAppBrowser === "line") {
        return {
            title: "LINEのブラウザでは録音できません",
            steps: [
                "画面右下の「…」（メニュー）をタップ",
                device === "ios"
                    ? "「Safariで開く」を選択"
                    : "「他のアプリで開く」→ Chrome を選択",
                "開いたブラウザでもう一度この画面を表示してください",
            ],
        };
    }

    const appName =
        inAppBrowser === "instagram"
            ? "Instagram"
            : inAppBrowser === "facebook"
                ? "Facebook"
                : inAppBrowser === "twitter"
                    ? "X (Twitter)"
                    : inAppBrowser === "tiktok"
                        ? "TikTok"
                        : "このアプリ";

    return {
        title: `${appName}のブラウザでは録音できません`,
        steps: [
            "画面のメニュー（… または ⋮）をタップ",
            device === "ios" ? "「Safariで開く」を選択" : "「ブラウザで開く」を選択",
            "開いたブラウザでもう一度この画面を表示してください",
        ],
    };
}
