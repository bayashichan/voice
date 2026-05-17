// Cloudflare Workers API URL設定
// 
// デプロイ後に表示されるWorkers URLを設定してください
// 例: https://voice-recorder-api.your-account.workers.dev
//
export const WORKERS_API_URL = "https://voice-recorder-api.wakaossan2001.workers.dev";

// 管理画面のパスワード
// デプロイ前に必ず変更してください
export const ADMIN_PASSWORD = "bayashi-voice-2026";

// ============ 以下は旧設定（GAS）============
// GAS(Google Apps Script)のWebアプリURL設定
// 
// 設定方法:
// 1. GASエディタで gas_code_reference.js の内容をコピーして新規プロジェクトを作成
// 2. デプロイ → 新しいデプロイ → ウェブアプリ を選択
// 3. 「アクセスできるユーザー」を「全員」に設定
// 4. デプロイ後に表示されるURLを下の GAS_WEB_APP_URL に設定
//
// 例: https://script.google.com/macros/s/AKfycbz_XXXXXXXX.../exec

export const GAS_WEB_APP_URL = "https://script.google.com/macros/s/AKfycbwDwK7mXEpYZvD5psFufrhlpdYPMPHyczz4ag2d2a0RzDuCNvJ-IdTsE8D4q-eQUGgAig/exec";

// 空の場合はローカルダウンロード機能のみが使えます
// URLを設定すると、録音データがGoogleドライブに自動保存されます
