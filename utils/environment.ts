export type DeviceType = "ios" | "android" | "pc";

export type InAppBrowser = "line" | "instagram" | "facebook" | "twitter" | "tiktok" | null;

export interface EnvironmentInfo {
    device: DeviceType;
    /** アプリ内ブラウザ（WebView）で開かれている場合はその種別 */
    inAppBrowser: InAppBrowser;
    /**
     * UAにアプリ名が出ない内蔵ブラウザも含めた推定。
     * LINEなど一部のアプリはUAをSafariとほぼ同じに見せるため、
     * UA判定だけでは取りこぼす。
     */
    likelyInAppBrowser: boolean;
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

/**
 * UAを詐称する内蔵ブラウザ（WKWebView）を機能で見分ける。
 *
 * iOS の本物の Safari とホーム画面追加アプリでは navigator.standalone が
 * 必ず定義されているが、アプリ内蔵の WKWebView では未定義になる。
 * 実際の失敗報告では UA が素の Safari と区別できず（"Line/" を含まない）、
 * UA判定だけでは内蔵ブラウザだと分からなかった。
 */
function detectLikelyInAppBrowser(
    rawUa: string,
    device: DeviceType,
    inApp: InAppBrowser
): boolean {
    if (inApp) return true;
    if (device !== "ios") return false;
    // iOS版のChrome / Firefox / Edge などは中身がWKWebViewでも本物のブラウザで、
    // マイクも使える。standalone が無いことを理由に警告してはいけない。
    if (/CriOS|FxiOS|EdgiOS|OPiOS|Coast/i.test(rawUa)) return false;
    return !("standalone" in navigator);
}

export function detectEnvironment(): EnvironmentInfo {
    if (typeof navigator === "undefined" || typeof window === "undefined") {
        return {
            device: "pc",
            inAppBrowser: null,
            likelyInAppBrowser: false,
            canRecord: true,
            isSecure: true,
        };
    }

    const rawUa = navigator.userAgent;
    const ua = rawUa.toLowerCase();

    const isSecure = window.isSecureContext === true;
    const canRecord =
        isSecure && typeof navigator.mediaDevices?.getUserMedia === "function";

    const device = detectDevice(ua);
    const inAppBrowser = detectInAppBrowser(rawUa);

    return {
        device,
        inAppBrowser,
        likelyInAppBrowser: detectLikelyInAppBrowser(rawUa, device, inAppBrowser),
        canRecord,
        isSecure,
    };
}

/**
 * LINE の内蔵ブラウザは openExternalBrowser=1 が付いたURLを
 * 端末の標準ブラウザ（iOSならSafari）で開き直す。LINE以外のアプリでは
 * 単に無視されるので、そのまま付けて問題ない。
 */
export function externalBrowserUrl(): string {
    if (typeof location === "undefined") return "";
    try {
        const url = new URL(location.href);
        url.searchParams.set("openExternalBrowser", "1");
        return url.toString();
    } catch {
        return location.href;
    }
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
                "下の「外部ブラウザで開き直す」ボタンをタップ",
                "開かない場合は画面右下の「…」（メニュー）をタップ",
                device === "ios"
                    ? "「Safariで開く」を選択"
                    : "「他のアプリで開く」→ Chrome を選択",
                "開いたブラウザでもう一度この画面を表示してください",
            ],
        };
    }

    if (inAppBrowser === null) {
        return {
            title: "アプリ内ブラウザでは録音できません",
            steps: [
                "下の「外部ブラウザで開き直す」ボタンをタップ",
                device === "ios"
                    ? "開かない場合は、画面のメニューから「Safariで開く」を選択"
                    : "開かない場合は、画面のメニューから「ブラウザで開く」を選択",
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
