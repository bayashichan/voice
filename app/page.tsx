"use client";

import { useState, useRef, useEffect } from "react";
import { Mic, CheckCircle2, AlertCircle, Loader2, Volume2, ArrowRight, Smartphone, Monitor, Settings, Shield } from "lucide-react";
import { AudioRecorder, AudioRecorderResult } from "@/utils/audioRecorder";
import { GlowCountdown } from "@/components/GlowCountdown";
import { AudioVisualizer } from "@/components/AudioVisualizer";
import { blobToBase64 } from "@/utils/fileHelpers";
import { cn } from "@/utils/cn";
import { WORKERS_API_URL } from "@/utils/config";

type AppState = "intro" | "privacy" | "step1" | "step2" | "step3" | "nameInput" | "micTest" | "countdown" | "recording" | "uploading" | "completed" | "iosDownload" | "error";
type DeviceType = "ios" | "android" | "pc";

export default function Home() {
  const [appState, setAppState] = useState<AppState>("intro");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const recorderRef = useRef<AudioRecorder | null>(null);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const [micTestAnalyser, setMicTestAnalyser] = useState<AnalyserNode | null>(null);
  const [micLevel, setMicLevel] = useState<number>(0);
  const micTestRecorderRef = useRef<AudioRecorder | null>(null);
  const [deviceType, setDeviceType] = useState<DeviceType>("pc");
  const [userName, setUserName] = useState<string>("");
  const isComposingRef = useRef<boolean>(false);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);

  // デバイス判定
  useEffect(() => {
    const ua = navigator.userAgent.toLowerCase();
    if (/iphone|ipad|ipod/.test(ua)) {
      setDeviceType("ios");
    } else if (/android/.test(ua)) {
      setDeviceType("android");
    } else {
      setDeviceType("pc");
    }
  }, []);

  // ステップ進行
  const nextStep = () => {
    if (appState === "intro") setAppState("privacy");
    else if (appState === "privacy") setAppState("step1");
    else if (appState === "step1") setAppState("step2");
    else if (appState === "step2") setAppState("step3");
    else if (appState === "step3") setAppState("nameInput");
  };

  // 名前入力後、マイクテストへ
  const proceedToMicTest = () => {
    if (userName.trim().length > 0) {
      setAppState("micTest");
    }
  };

  // マイク許可を取得して録音へ進む（シンプル版）
  const requestMicPermissionAndProceed = async () => {
    try {
      // マイク許可だけを取得
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // 許可が取れたらすぐにストリームを停止
      stream.getTracks().forEach(track => track.stop());

      // 許可が取れたのでカウントダウンへ
      recorderRef.current = new AudioRecorder();
      setAppState("countdown");
    } catch (e) {
      console.error(e);
      setErrorMsg("マイクへのアクセスが許可されていません。ブラウザの設定を確認してください。");
      setAppState("error");
    }
  };

  const startRecording = async () => {
    if (!recorderRef.current) return;
    try {
      setAppState("recording");
      const analyserNode = await recorderRef.current.start();
      setAnalyser(analyserNode);
    } catch (e) {
      console.error("Recording failed:", e);
      setErrorMsg("録音の開始に失敗しました。");
      setAppState("error");
    }
  };

  // 10秒タイマー
  useEffect(() => {
    let timer: NodeJS.Timeout;
    if (appState === "recording") {
      timer = setTimeout(async () => {
        await stopAndUpload();
      }, 10000); // 10秒
    }
    return () => clearTimeout(timer);
  }, [appState]);

  const stopAndUpload = async () => {
    if (!recorderRef.current) return;
    setAppState("uploading");

    let step = "録音処理";
    try {
      // Step 1: 録音停止
      step = "録音停止";
      const result: AudioRecorderResult = await recorderRef.current.stop();

      // 録音データを保存（ダウンロード用フォールバック）
      setRecordedBlob(result.blob);

      // Step 2: Base64エンコード
      step = "データ変換";
      const base64 = await blobToBase64(result.blob);

      // Step 3: Workers (Cloudflare R2) に送信
      step = "サーバー送信";
      const res = await fetch(`${WORKERS_API_URL}/upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileData: base64,
          mimeType: "audio/wav",
          userName: userName,
        }),
      });

      if (!res.ok) throw new Error(`upload failed: ${res.status}`);
      const json = await res.json() as { result: string };
      if (json.result !== "success") throw new Error("upload result error");

      setAppState("completed");

    } catch (e: unknown) {
      console.error(`エラー発生場所: ${step}`, e);
      // ネットワークエラー等の場合はダウンロード画面を表示
      setAppState("iosDownload");
    }
  };

  const resetApp = () => {
    setAppState("intro");
    setErrorMsg("");
    setAnalyser(null);
    setMicTestAnalyser(null);
    setMicLevel(0);
    setUserName("");
  };

  // 録音だけやり直し（名前はそのまま）
  const retryRecording = () => {
    setAppState("micTest");
    setAnalyser(null);
  };

  // デバイス別マイク許可ガイド
  const getMicPermissionGuide = () => {
    if (deviceType === "ios") {
      return {
        icon: <Smartphone className="w-8 h-8 md:w-10 md:h-10" />,
        title: "iPhone / iPad",
        steps: [
          "ポップアップで「許可」をタップ",
          "許可画面が出ない場合：",
          "設定 → Safari → マイク → 許可"
        ]
      };
    } else if (deviceType === "android") {
      return {
        icon: <Smartphone className="w-8 h-8 md:w-10 md:h-10" />,
        title: "Android",
        steps: [
          "ポップアップで「許可」をタップ",
          "許可画面が出ない場合：",
          "設定 → アプリ → ブラウザ → 権限 → マイク → 許可"
        ]
      };
    } else {
      return {
        icon: <Monitor className="w-8 h-8 md:w-10 md:h-10" />,
        title: "パソコン",
        steps: [
          "アドレスバー左の🔒アイコンをクリック",
          "「マイク」を「許可」に変更",
          "ページを再読み込み"
        ]
      };
    }
  };

  const permissionGuide = getMicPermissionGuide();

  // 共通のフルスクリーンラッパー
  const FullScreenWrapper = ({ children }: { children: React.ReactNode }) => (
    <div className="fixed inset-0 z-50 bg-gray-950 flex flex-col items-center justify-center p-4 md:p-8 animate-[fadeIn_0.8s_ease-out]">
      <style jsx>{`
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(20px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[400px] md:w-[600px] h-[400px] md:h-[600px] bg-blue-900/10 rounded-full blur-[100px] md:blur-[120px]" />
      </div>
      <div className="z-10 w-full max-w-lg flex flex-col items-center text-center">
        {children}
      </div>
    </div>
  );

  // 確認ボタン
  const ConfirmButton = ({ onClick, text = "確認しました" }: { onClick: () => void; text?: string }) => (
    <button
      onClick={onClick}
      className="w-full max-w-sm py-4 md:py-5 bg-gradient-to-r from-blue-600 to-indigo-600 rounded-xl md:rounded-2xl font-bold text-lg md:text-xl hover:opacity-90 transition-all flex items-center justify-center gap-2 shadow-lg shadow-blue-900/30 hover:shadow-blue-900/50"
    >
      {text}
      <ArrowRight className="w-5 h-5 md:w-6 md:h-6" />
    </button>
  );

  return (
    <main className="min-h-screen bg-gray-950 text-white flex flex-col items-center justify-center p-4 relative overflow-hidden">
      {/* Background Decor */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-[-20%] left-[-20%] w-[300px] md:w-[500px] h-[300px] md:h-[500px] bg-purple-900/20 rounded-full blur-[80px] md:blur-[100px]" />
        <div className="absolute bottom-[-20%] right-[-20%] w-[300px] md:w-[500px] h-[300px] md:h-[500px] bg-blue-900/20 rounded-full blur-[80px] md:blur-[100px]" />
      </div>

      {/* State: INTRO */}
      {appState === "intro" && (
        <FullScreenWrapper>
          <h1 className="text-3xl md:text-5xl lg:text-6xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 via-purple-400 to-blue-400 mb-6 md:mb-10">
            声紋診断レコーダー
          </h1>
          <p className="text-lg md:text-2xl text-gray-300 mb-8 md:mb-12 leading-relaxed">
            声紋診断のための<br />
            <span className="text-white font-medium">高品質な音声録音</span>を行います
          </p>
          <ConfirmButton onClick={nextStep} text="はじめる" />

          {/* フッター */}
          <div className="absolute bottom-4 md:bottom-6 left-0 right-0 text-center text-xs md:text-sm text-gray-600">
            © 声紋診断アップデート林
          </div>
        </FullScreenWrapper>
      )}

      {/* State: PRIVACY - プライバシーポリシー */}
      {appState === "privacy" && (
        <FullScreenWrapper>
          <div className="flex items-center justify-center gap-3 text-cyan-400 mb-6">
            <Shield className="w-8 h-8 md:w-10 md:h-10" />
          </div>
          <h2 className="text-2xl md:text-4xl font-bold text-white mb-6 md:mb-8">
            プライバシーについて
          </h2>
          <div className="bg-gray-900/50 backdrop-blur-sm rounded-2xl p-6 md:p-8 border border-gray-800 text-left space-y-4 mb-8">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="w-5 h-5 text-green-400 mt-0.5 flex-shrink-0" />
              <p className="text-sm md:text-base text-gray-300">
                録音した音声データは<span className="text-white font-medium">声紋診断のためだけ</span>に使用します
              </p>
            </div>
            <div className="flex items-start gap-3">
              <CheckCircle2 className="w-5 h-5 text-green-400 mt-0.5 flex-shrink-0" />
              <p className="text-sm md:text-base text-gray-300">
                他の目的への<span className="text-white font-medium">流用は一切いたしません</span>
              </p>
            </div>
            <div className="flex items-start gap-3">
              <CheckCircle2 className="w-5 h-5 text-green-400 mt-0.5 flex-shrink-0" />
              <p className="text-sm md:text-base text-gray-300">
                分析完了後、音声データは<span className="text-white font-medium">速やかに削除</span>いたします
              </p>
            </div>
          </div>
          <ConfirmButton onClick={nextStep} text="同意して続ける" />

          <div className="absolute bottom-4 md:bottom-6 left-0 right-0 text-center text-xs md:text-sm text-gray-600">
            © 声紋診断アップデート林
          </div>
        </FullScreenWrapper>
      )}

      {/* State: STEP 1 */}
      {appState === "step1" && (
        <FullScreenWrapper>
          <div className="text-blue-400 text-sm md:text-base mb-4 tracking-widest">STEP 1 / 3</div>
          <h2 className="text-2xl md:text-4xl lg:text-5xl font-bold text-white mb-6 md:mb-10 leading-tight">
            静かで落ち着いた<br />
            <span className="text-cyan-400">環境</span>で行ってください
          </h2>
          <p className="text-base md:text-xl text-gray-400 mb-4">
            反響の少ない部屋が理想的です
          </p>
          <div className="bg-yellow-900/30 border border-yellow-700/50 rounded-xl p-4 mb-8 md:mb-12">
            <p className="text-sm md:text-base text-yellow-300">
              ⚠️ <span className="font-medium">Bluetoothイヤホンマイクは使用せず</span>、<br />
              スマホ本体のマイクで直接録音してください。<br />
              <span className="text-yellow-400/80 text-xs">（分析精度に影響します）</span>
            </p>
          </div>
          <ConfirmButton onClick={nextStep} />
        </FullScreenWrapper>
      )}

      {/* State: STEP 2 */}
      {appState === "step2" && (
        <FullScreenWrapper>
          <div className="text-blue-400 text-sm md:text-base mb-4 tracking-widest">STEP 2 / 3</div>
          <h2 className="text-2xl md:text-4xl lg:text-5xl font-bold text-white mb-6 md:mb-10 leading-tight">
            <span className="text-purple-400">フルネーム</span>を<br />
            自然なペースで<br />
            繰り返し言ってください
          </h2>
          <p className="text-base md:text-xl text-gray-400 mb-8 md:mb-12">
            早口や、ゆっくり言う必要はありません
          </p>
          <ConfirmButton onClick={nextStep} />
        </FullScreenWrapper>
      )}

      {/* State: STEP 3 */}
      {appState === "step3" && (
        <FullScreenWrapper>
          <div className="text-blue-400 text-sm md:text-base mb-4 tracking-widest">STEP 3 / 3</div>
          <h2 className="text-2xl md:text-4xl lg:text-5xl font-bold text-white mb-6 md:mb-10 leading-tight">
            例えば...
          </h2>
          <div className="bg-gray-900/50 backdrop-blur-sm rounded-2xl p-6 md:p-8 border border-gray-800 mb-8 md:mb-12">
            <p className="text-xl md:text-3xl text-gray-300 italic">
              「やまだ たろう...<br />
              やまだ たろう...」
            </p>
          </div>
          <ConfirmButton onClick={nextStep} text="準備OK" />
        </FullScreenWrapper>
      )}

      {/* State: NAME INPUT - 名前入力（アニメーションなし） */}
      {appState === "nameInput" && (
        <div className="fixed inset-0 z-50 bg-gray-950 flex flex-col items-center justify-center p-4 md:p-8">
          <div className="absolute inset-0 pointer-events-none overflow-hidden">
            <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[400px] md:w-[600px] h-[400px] md:h-[600px] bg-blue-900/10 rounded-full blur-[100px] md:blur-[120px]" />
          </div>
          <div className="z-10 w-full max-w-lg flex flex-col items-center text-center">
            <h2 className="text-2xl md:text-4xl font-bold text-white mb-6 md:mb-8">
              お名前を入力してください
            </h2>
            <p className="text-sm md:text-base text-gray-400 mb-6">
              録音データの識別に使用します
            </p>

            <div className="w-full max-w-sm space-y-6">
              <input
                type="text"
                defaultValue=""
                onChange={(e) => setUserName(e.target.value)}
                placeholder="例：山田太郎"
                className="w-full px-4 py-4 bg-gray-900/80 border border-gray-700 rounded-xl text-white text-lg md:text-xl text-center placeholder-gray-500 focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500"
                autoFocus
              />

              <button
                onClick={proceedToMicTest}
                disabled={userName.trim().length === 0}
                className={cn(
                  "w-full py-4 md:py-5 rounded-xl md:rounded-2xl font-bold text-lg md:text-xl transition-all flex items-center justify-center gap-2 shadow-lg",
                  userName.trim().length > 0
                    ? "bg-gradient-to-r from-blue-600 to-indigo-600 hover:opacity-90 shadow-blue-900/30"
                    : "bg-gray-700 text-gray-400 cursor-not-allowed"
                )}
              >
                次へ
                <ArrowRight className="w-5 h-5 md:w-6 md:h-6" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* State: MIC TEST - シンプル版 */}
      {appState === "micTest" && (
        <FullScreenWrapper>
          <h2 className="text-2xl md:text-4xl font-bold text-white mb-6 md:mb-8">
            マイクの許可
          </h2>

          <div className="w-full space-y-6 md:space-y-8">
            {/* マイク許可ガイド */}
            <div className="bg-gray-900/50 backdrop-blur-sm rounded-2xl p-6 md:p-8 border border-gray-800">
              <div className="flex items-center justify-center gap-3 text-cyan-400 mb-4 md:mb-6">
                {permissionGuide.icon}
                <span className="font-medium text-lg md:text-xl">{permissionGuide.title}</span>
              </div>

              <p className="text-sm md:text-base text-gray-400 mb-4 text-center">
                ボタンを押すとマイクの許可を求められます。<br />
                「許可」を選択してください。
              </p>

              <div className="space-y-3 md:space-y-4 text-left">
                {permissionGuide.steps.map((step, i) => (
                  <div key={i} className="flex items-start gap-3">
                    <span className="text-blue-400 font-bold text-sm md:text-base">{i + 1}.</span>
                    <p className="text-sm md:text-base text-gray-300">{step}</p>
                  </div>
                ))}
              </div>
            </div>

            <p className="text-sm md:text-base text-cyan-400/80 text-center mb-2">
              ※ 許可後、<span className="font-bold">3→2→1</span> のカウントダウンで録音開始します
            </p>

            <button
              onClick={requestMicPermissionAndProceed}
              className="w-full max-w-sm mx-auto py-4 md:py-5 bg-gradient-to-r from-cyan-600 to-blue-600 rounded-xl md:rounded-2xl font-bold text-lg md:text-xl hover:opacity-90 transition-all flex items-center justify-center gap-2 shadow-lg shadow-cyan-900/30"
            >
              <Mic className="w-5 h-5 md:w-6 md:h-6" />
              マイクを許可して録音開始
            </button>

            {/* 他のデバイスもみる */}
            <details className="text-gray-500 text-sm">
              <summary className="cursor-pointer hover:text-gray-300 flex items-center gap-2 justify-center">
                <Settings className="w-4 h-4" />
                他のデバイスの設定方法
              </summary>
              <div className="mt-4 space-y-4 text-left bg-gray-900/30 p-4 rounded-xl">
                <div>
                  <p className="text-cyan-400 font-medium mb-1">iPhone / iPad</p>
                  <p className="text-xs text-gray-400">設定 → Safari → マイク → 許可</p>
                </div>
                <div>
                  <p className="text-green-400 font-medium mb-1">Android</p>
                  <p className="text-xs text-gray-400">設定 → アプリ → ブラウザ → 権限 → マイク</p>
                </div>
                <div>
                  <p className="text-purple-400 font-medium mb-1">パソコン</p>
                  <p className="text-xs text-gray-400">アドレスバー🔒 → マイク → 許可</p>
                </div>
              </div>
            </details>
          </div>
        </FullScreenWrapper>
      )}

      <div className="z-10 w-full max-w-md flex flex-col items-center space-y-6 md:space-y-8">

        {/* Header (メイン画面用) */}
        {!["intro", "privacy", "step1", "step2", "step3", "micTest"].includes(appState) && (
          <h1 className="text-2xl md:text-4xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-purple-400">
            声紋診断レコーダー
          </h1>
        )}

        {/* State: COUNTDOWN */}
        {appState === "countdown" && (
          <GlowCountdown onComplete={startRecording} />
        )}

        {/* State: RECORDING */}
        {appState === "recording" && (
          <div className="w-full flex flex-col items-center space-y-6">
            <div className="text-cyan-400 font-medium text-lg md:text-xl animate-pulse">
              フルネームを繰り返し言ってください。
            </div>
            {analyser && <AudioVisualizer analyser={analyser} isRecording={true} />}
            <div className="w-full h-3 md:h-4 bg-gray-800 rounded-full overflow-hidden">
              <div className="h-full bg-cyan-500" style={{ animation: 'progress 10s linear forwards' }} />
              <style jsx>{`
                 @keyframes progress {
                   from { width: 0%; }
                   to { width: 100%; }
                 }
               `}</style>
            </div>
          </div>
        )}

        {/* State: UPLOADING */}
        {appState === "uploading" && (
          <div className="flex flex-col items-center space-y-4 md:space-y-6">
            <Loader2 className="w-16 h-16 md:w-20 md:h-20 text-blue-500 animate-spin" />
            <p className="text-lg md:text-2xl font-medium">保存中...</p>
            <p className="text-sm md:text-base text-gray-500">この処理には数秒かかる場合があります</p>
            <p className="text-xs text-red-400 animate-pulse">⚠️ 完了するまでブラウザを閉じないでください</p>
          </div>
        )}

        {/* State: COMPLETED */}
        {appState === "completed" && (
          <div className="flex flex-col items-center space-y-6 md:space-y-8 bg-green-950/20 p-8 md:p-12 rounded-3xl border border-green-900/50">
            <CheckCircle2 className="w-20 h-20 md:w-24 md:h-24 text-green-500 animate-bounce" />
            <div className="text-center">
              <h2 className="text-2xl md:text-3xl font-bold text-green-400 mb-3">保存完了</h2>
              <p className="text-gray-300 text-base md:text-lg">
                {userName}さんの声紋診断データを保存しました。<br />
                ご協力ありがとうございました。
              </p>
            </div>

            {/* メインメッセージ: ブラウザを閉じてOK */}
            <div className="w-full max-w-sm bg-green-900/30 border border-green-700/50 rounded-xl p-4 text-center">
              <p className="text-green-300 font-medium text-base md:text-lg">
                ✓ このままブラウザを閉じてOKです
              </p>
            </div>

            <p className="text-xs md:text-sm text-gray-500 text-center">
              ※ 音声データは分析完了後、速やかに削除いたします
            </p>

            {/* やり直しボタン - 控えめに */}
            <div className="w-full max-w-sm pt-4 border-t border-gray-800">
              <p className="text-xs text-gray-500 text-center mb-2">
                録音をやり直したい場合のみ
              </p>
              <button
                onClick={retryRecording}
                className="w-full py-2 bg-gray-700 rounded-lg text-sm text-gray-300 hover:bg-gray-600 transition-colors"
              >
                録音し直す
              </button>
            </div>

            <div className="text-xs text-gray-600 mt-4">
              © 声紋診断アップデート林
            </div>
          </div>
        )}

        {/* State: iOS DOWNLOAD - iPhoneユーザー用ダウンロード画面 */}
        {appState === "iosDownload" && recordedBlob && (
          <div className="flex flex-col items-center space-y-6 md:space-y-8 bg-blue-950/20 p-8 md:p-12 rounded-3xl border border-blue-900/50">
            <CheckCircle2 className="w-20 h-20 md:w-24 md:h-24 text-blue-500" />
            <div className="text-center">
              <h2 className="text-2xl md:text-3xl font-bold text-blue-400 mb-3">録音完了！</h2>
              <p className="text-gray-300 text-base md:text-lg">
                {userName}さんの声紋診断データを録音しました
              </p>
            </div>

            <div className="w-full max-w-sm bg-blue-900/30 border border-blue-700/50 rounded-xl p-4 text-center space-y-4">
              <p className="text-blue-300 font-medium text-base md:text-lg">
                📱 下のボタンでダウンロードして<br />
                公式LINEでアップデート林に送ってください
              </p>
              <a
                href={URL.createObjectURL(recordedBlob)}
                download={`${userName || 'voice'}_${new Date().toISOString().slice(0, 10)}.wav`}
                className="block w-full py-4 bg-gradient-to-r from-blue-600 to-indigo-600 rounded-xl font-bold text-lg hover:opacity-90 transition-all shadow-lg shadow-blue-900/30"
              >
                録音をダウンロード
              </a>
            </div>

            <p className="text-xs md:text-sm text-gray-400 text-center">
              ダウンロードしたデータを公式LINEで<br />
              アップデート林に送ってください
            </p>

            <div className="w-full max-w-sm pt-4 border-t border-gray-800">
              <p className="text-xs text-gray-500 text-center mb-2">
                録音をやり直したい場合
              </p>
              <button
                onClick={retryRecording}
                className="w-full py-2 bg-gray-700 rounded-lg text-sm text-gray-300 hover:bg-gray-600 transition-colors"
              >
                録音し直す
              </button>
            </div>

            <div className="text-xs text-gray-600 mt-4">
              © 声紋診断アップデート林
            </div>
          </div>
        )}

        {/* State: ERROR */}
        {appState === "error" && (
          <div className="flex flex-col items-center space-y-6 bg-red-950/20 p-8 md:p-10 rounded-3xl border border-red-900/50">
            <AlertCircle className="w-20 h-20 md:w-24 md:h-24 text-red-500" />
            <div className="text-center">
              <h2 className="text-xl md:text-2xl font-bold text-red-400 mb-2">エラーが発生しました</h2>
              <p className="text-gray-300 text-base md:text-lg">{errorMsg || "不明なエラーです"}</p>
            </div>

            {/* 録音データがある場合はダウンロードボタンを表示 */}
            {recordedBlob && (
              <div className="w-full max-w-sm space-y-3">
                <p className="text-sm text-yellow-400 text-center">
                  📱 iPhoneをお使いの場合は、下のボタンで録音をダウンロードしてLINEで送信してください
                </p>
                <a
                  href={URL.createObjectURL(recordedBlob)}
                  download={`${userName || 'voice'}_${new Date().toISOString().slice(0, 10)}.wav`}
                  className="block w-full py-3 bg-blue-600 rounded-xl font-bold text-center text-lg hover:bg-blue-700 transition-colors"
                >
                  録音をダウンロード
                </a>
              </div>
            )}

            <button
              onClick={resetApp}
              className="w-full max-w-sm py-4 bg-red-600 rounded-xl font-bold text-lg hover:bg-red-700 transition-colors"
            >
              もう一度試す
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
