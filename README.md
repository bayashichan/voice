# 声紋診断レコーダー

## デプロイ構成

| 役割 | 置き場所 | デプロイ方法 |
| --- | --- | --- |
| フロントエンド（本番） | Vercel: https://voice-rho-red.vercel.app | main への push で自動デプロイ |
| 保存API | Cloudflare Workers: voice-recorder-api | `.github/workflows/deploy-worker.yml`（Actions から実行） |
| 音声の保存先 | Cloudflare R2: voice-recordings | Worker 経由 |
| 失敗・完了の通知 | Google Apps Script | Worker のシークレット `GAS_WEB_APP_URL` |

**フロントエンドの本番は Vercel だけ**。以前あった Cloudflare Pages
(voice-recorder-aba.pages.dev) は廃止した。配信元が2つあると、古い版が残っている方の
URLを案内してしまい「直したはずの不具合が直っていない」という事故が起きる。
公式LINEなどで配るURLは Vercel のものに統一すること。

LINEのメッセージからリンクする場合は、末尾に `?openExternalBrowser=1` を付ける。
LINEの内蔵ブラウザではマイクが使えず録音できないため、標準ブラウザで開かせる必要がある。

## 録音データの形式（VoiceScan でそのまま解析できる形）

録音は VoiceScan（声分析ソフト）の録音と同じ形式で保存する（`utils/voicescanFormat.ts`）。

- 22050Hz / 16bit / モノラル、ピークを 32767 に正規化（VoiceScan の Normalize16 と同じ）
- 長さは VoiceScan の録音時間「12秒」設定と同じ 289380 サンプル（約13.1秒、ファイル 578,804 バイト）。
  VoiceScan はファイルサイズから解析設定を決めるので、この長さだと 12 秒設定（先頭約11.9秒を解析）で開かれる
- 端末のサンプリングレートで取り込み、VoiceScanWeb2 の `js/recorder.js`（`MicRecorder.toWav`）と同じ処理で変換する。
  同じ入力ならバイト単位で同じ WAV になる。どちらかを変えたら両方そろえること
- 録音後に「音割れ率 0.1% 以上」「推定SN比 25dB 未満」なら録り直しを勧める（送信も可）。
  音量そのものは正規化で揃うため結果にほぼ影響しない（根拠: VoiceScan 側 `検証ツール/実録音比較/level.js`）
- 取り込み時の情報（取り込みレート・音声処理の有無・音割れ率・SN比など）をアップロードのクエリで送り、
  Worker が R2 のメタデータに保存する。VoiceScan Web の「録音サイトから開く」の一覧に品質として表示される

VoiceScan Web からは管理API（`/list`・`/download`・`/delete`、パスワードは `ADMIN_PASSWORD`）で直接開ける。

## ローカルでの動作確認（本番に送らない）

```bash
cd workers && npx wrangler dev --port 8787   # R2 はローカルの模擬。workers/.dev.vars に ADMIN_PASSWORD を書く
NEXT_PUBLIC_WORKERS_API_URL=http://127.0.0.1:8787 npm run dev
```

---

This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
