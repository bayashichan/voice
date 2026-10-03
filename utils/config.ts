// Cloudflare Workers API URL設定
//
// デプロイ後に表示されるWorkers URLを設定してください
// 例: https://voice-recorder-api.your-account.workers.dev
//
// ローカル検証では NEXT_PUBLIC_WORKERS_API_URL に wrangler dev のURLを入れて本番に送らないようにする
export const WORKERS_API_URL =
  process.env.NEXT_PUBLIC_WORKERS_API_URL || "https://voice-recorder-api.wakaossan2001.workers.dev";

// ⚠️ このファイルの内容は静的ビルドされ、全訪問者に配信されるJSに含まれます。
//    パスワードやWebhook URLなどの秘密情報は絶対に置かないでください。
//
//    管理画面のパスワードは Cloudflare Workers 側のシークレットで管理します:
//      cd workers && npx wrangler secret put ADMIN_PASSWORD
//    GASの通知URLも同様です:
//      cd workers && npx wrangler secret put GAS_WEB_APP_URL
//    管理画面はログイン時に入力されたパスワードをそのままAPIトークンとして使うため、
//    ブラウザ側にパスワードを埋め込む必要はありません。

/**
 * 画面に出す録音時間（秒）。
 * 実際の取り込み長は VoiceScan の録音時間「12秒」設定と同じ（約13.1秒、utils/voicescanFormat.ts）。
 * VoiceScan はファイルの長さから解析設定を決めるため、この長さでないと 12 秒設定で解析されない。
 */
export const RECORDING_DISPLAY_SEC = 13;

/** ピーク振幅がこの値未満なら「音が入っていない」と判定する（約 -40dBFS） */
export const SILENCE_PEAK_THRESHOLD = 0.01;

/**
 * フルスケール付近のサンプルがこの割合を超えたら「音割れ」として録り直しを勧める。
 * 音割れは偽の倍音を足すため解析結果が変わる。オリジナルの実録音で測った上位3色の一致率は
 * 音割れ率 0.02%→98%、0.12%→93%、0.25%→88%、1.25%→65%。
 */
export const CLIP_RATIO_THRESHOLD = 0.001;

/**
 * 声と背景雑音の差（推定SN比, dB）がこれ未満なら録り直しを勧める。
 * 解析は録音全体のピークで正規化するため、音量そのもの（ゲイン）は結果に影響しないが、
 * 雑音に対して声が小さいと結果が変わる（SN比 約35dB→上位3色一致98%、約25dB→83%）。
 * オリジナルで録音された実録音は中央値 54dB、下位5% が 27dB。
 */
export const MIN_SNR_DB = 25;

/** 録音中に音声データがこの時間届かなければ、マイクが止まったとみなす */
export const RECORDING_STALL_MS = 3_000;

/** 収録が止まらない場合の壁時計の安全上限（取り込み約13.1秒 + 余裕） */
export const RECORDING_HARD_TIMEOUT_MS = 25_000;
