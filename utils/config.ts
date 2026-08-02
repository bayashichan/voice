// Cloudflare Workers API URL設定
//
// デプロイ後に表示されるWorkers URLを設定してください
// 例: https://voice-recorder-api.your-account.workers.dev
//
export const WORKERS_API_URL = "https://voice-recorder-api.wakaossan2001.workers.dev";

// ⚠️ このファイルの内容は静的ビルドされ、全訪問者に配信されるJSに含まれます。
//    パスワードやWebhook URLなどの秘密情報は絶対に置かないでください。
//
//    管理画面のパスワードは Cloudflare Workers 側のシークレットで管理します:
//      cd workers && npx wrangler secret put ADMIN_PASSWORD
//    GASの通知URLも同様です:
//      cd workers && npx wrangler secret put GAS_WEB_APP_URL
//    管理画面はログイン時に入力されたパスワードをそのままAPIトークンとして使うため、
//    ブラウザ側にパスワードを埋め込む必要はありません。

/** 収録する秒数 */
export const RECORDING_DURATION_SEC = 10;

/** 収録がこの秒数に満たない場合は失敗として扱う */
export const MIN_ACCEPTABLE_DURATION_SEC = 5;

/** ピーク振幅がこの値未満なら「音が入っていない」と判定する（約 -40dBFS） */
export const SILENCE_PEAK_THRESHOLD = 0.01;

/** 収録が止まらない場合の壁時計の安全上限 */
export const RECORDING_HARD_TIMEOUT_MS = 15_000;
