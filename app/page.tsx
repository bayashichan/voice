"use client";

import { useState, useRef, useEffect } from "react";
import { Mic, CheckCircle2, AlertCircle, Loader2 } from "lucide-react";
import { AudioRecorder, AudioRecorderResult } from "@/utils/audioRecorder";
import { GlowCountdown } from "@/components/GlowCountdown";
import { AudioVisualizer } from "@/components/AudioVisualizer";
import { blobToBase64 } from "@/utils/fileHelpers";
import { cn } from "@/utils/cn";

type AppState = "idle" | "countdown" | "recording" | "uploading" | "completed" | "error";

export default function Home() {
  const [appState, setAppState] = useState<AppState>("idle");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const recorderRef = useRef<AudioRecorder | null>(null);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);

  // マイク権限の確認とRecorderの初期化
  const initializeRecorder = async () => {
    try {
      recorderRef.current = new AudioRecorder();
      // まず権限だけ確認するのは難しいので、実際の開始時に行う
      setAppState("countdown");
    } catch (e) {
      console.error(e);
      setErrorMsg("マイクへのアクセスが許可されていません。");
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
      }, 10000);
    }
    return () => clearTimeout(timer);
  }, [appState]);

  const stopAndUpload = async () => {
    if (!recorderRef.current) return;
    setAppState("uploading");

    try {
      const result: AudioRecorderResult = await recorderRef.current.stop();
      const base64 = await blobToBase64(result.blob);

      // 送信処理
      const response = await fetch("/api/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileData: base64, mimeType: "audio/wav" }),
      });

      if (!response.ok) throw new Error("Server error");

      const data = await response.json();
      if (data.result === "success") {
        setAppState("completed");
      } else {
        throw new Error("Upload failed verification");
      }

    } catch (e) {
      console.error(e);
      setErrorMsg("保存に失敗しました。ネットワーク接続を確認して再試行してください。");
      setAppState("error");
    }
  };

  const resetApp = () => {
    setAppState("idle");
    setErrorMsg("");
    setAnalyser(null);
  };

  return (
    <main className="min-h-screen bg-gray-950 text-white flex flex-col items-center justify-center p-4 relative overflow-hidden">
      {/* Background Decor */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-[-20%] left-[-20%] w-[500px] h-[500px] bg-purple-900/20 rounded-full blur-[100px]" />
        <div className="absolute bottom-[-20%] right-[-20%] w-[500px] h-[500px] bg-blue-900/20 rounded-full blur-[100px]" />
      </div>

      <div className="z-10 w-full max-w-md flex flex-col items-center space-y-8 animate-in fade-in duration-700">

        {/* Header / Title */}
        <h1 className="text-2xl md:text-3xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-purple-400">
          声紋分析レコーダー
        </h1>

        {/* State: IDLE */}
        {appState === "idle" && (
          <div className="flex flex-col space-y-6 text-center bg-gray-900/50 p-6 rounded-2xl border border-gray-800 backdrop-blur-sm">
            <div className="space-y-4 text-gray-300">
              <p className="font-medium text-lg text-white">以下の手順で録音を行います</p>
              <ul className="text-sm space-y-3 text-left list-disc list-inside bg-black/20 p-4 rounded-lg">
                <li>静かで落ち着いた環境かつ、反響の少ない部屋で行ってください。</li>
                <li>「自分の名前（フルネーム）」を約10秒間、繰り返し言い続けてください。</li>
                <li className="text-gray-400 italic">例：「やまだ たろう... やまだ たろう...」</li>
              </ul>
            </div>
            <button
              onClick={initializeRecorder}
              className="w-full py-4 bg-gradient-to-r from-blue-600 to-indigo-600 rounded-xl font-bold text-lg hover:opacity-90 transition-opacity flex items-center justify-center gap-2 shadow-lg shadow-blue-900/20"
            >
              <Mic className="w-5 h-5" />
              準備完了
            </button>
          </div>
        )}

        {/* State: COUNTDOWN */}
        {appState === "countdown" && (
          <GlowCountdown onComplete={startRecording} />
        )}

        {/* State: RECORDING */}
        {appState === "recording" && (
          <div className="w-full flex flex-col items-center space-y-6">
            <div className="text-cyan-400 font-medium animate-pulse">
              10秒間、名前を繰り返してください...
            </div>
            {analyser && <AudioVisualizer analyser={analyser} isRecording={true} />}
            <div className="w-full h-2 bg-gray-800 rounded-full overflow-hidden">
              <div className="h-full bg-cyan-500 animate-[width_10s_linear_forwards] w-0" style={{ animationName: 'progress', animationDuration: '10s', animationTimingFunction: 'linear', animationFillMode: 'forwards' }} />
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
          <div className="flex flex-col items-center space-y-4">
            <Loader2 className="w-16 h-16 text-blue-500 animate-spin" />
            <p className="text-lg font-medium">Googleドライブへ保存中...</p>
            <p className="text-sm text-gray-500">この処理には数秒かかる場合があります</p>
          </div>
        )}

        {/* State: COMPLETED */}
        {appState === "completed" && (
          <div className="flex flex-col items-center space-y-6 bg-green-950/20 p-8 rounded-3xl border border-green-900/50">
            <CheckCircle2 className="w-20 h-20 text-green-500 animate-bounce" />
            <div className="text-center">
              <h2 className="text-2xl font-bold text-green-400 mb-2">保存完了</h2>
              <p className="text-gray-300">声紋データの送信が完了しました。<br />ご協力ありがとうございました。</p>
            </div>
            <button
              onClick={resetApp}
              className="px-6 py-2 bg-gray-800 rounded-full text-sm font-medium hover:bg-gray-700 transition-colors"
            >
              最初の画面に戻る
            </button>
          </div>
        )}

        {/* State: ERROR */}
        {appState === "error" && (
          <div className="flex flex-col items-center space-y-6 bg-red-950/20 p-8 rounded-3xl border border-red-900/50">
            <AlertCircle className="w-20 h-20 text-red-500" />
            <div className="text-center">
              <h2 className="text-xl font-bold text-red-400 mb-2">エラーが発生しました</h2>
              <p className="text-gray-300">{errorMsg || "不明なエラーです"}</p>
            </div>
            <button
              onClick={resetApp}
              className="w-full py-3 bg-red-600 rounded-xl font-bold hover:bg-red-700 transition-colors"
            >
              もう一度試す
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
