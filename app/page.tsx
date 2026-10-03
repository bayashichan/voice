"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import {
  Mic,
  CheckCircle2,
  AlertCircle,
  Loader2,
  ArrowRight,
  Smartphone,
  Monitor,
  Settings,
  Shield,
  ExternalLink,
  Copy,
  Check,
  Share2,
  Download,
  RefreshCw,
} from "lucide-react";
import {
  AudioRecorder,
  AudioRecorderResult,
  MicMetrics,
  TrackInfo,
} from "@/utils/audioRecorder";
import { GlowCountdown } from "@/components/GlowCountdown";
import { AudioVisualizer } from "@/components/AudioVisualizer";
import { MicLevelMeter } from "@/components/MicLevelMeter";
import { uploadRecording, reportFailure } from "@/utils/uploadRecording";
import { cn } from "@/utils/cn";
import {
  RECORDING_DISPLAY_SEC,
  RECORDING_HARD_TIMEOUT_MS,
  RECORDING_STALL_MS,
  SILENCE_PEAK_THRESHOLD,
  CLIP_RATIO_THRESHOLD,
  MIN_SNR_DB,
} from "@/utils/config";
import { VOICESCAN_RECORD_SEC, VOICESCAN_SAMPLE_RATE } from "@/utils/voicescanFormat";
import {
  detectEnvironment,
  getExternalBrowserGuide,
  externalBrowserUrl,
  type EnvironmentInfo,
} from "@/utils/environment";
import { describeMicError, type MicErrorInfo } from "@/utils/micErrors";

type AppState =
  | "intro"
  | "privacy"
  | "step1"
  | "step2"
  | "step3"
  | "nameInput"
  | "micTest"
  | "micReady"
  | "countdown"
  | "recording"
  | "uploading"
  | "completed"
  | "uploadFailed"
  | "error";

function errorNameOf(e: unknown): string {
  if (e instanceof Error && e.name) return e.name;
  return "UnknownError";
}

interface MicAttemptDiagnostics {
  /** マイク要求から失敗までの経過ミリ秒。許可ダイアログが出たかの手がかり */
  elapsedMs: number;
  /** Permissions API から見た状態。非対応環境では "unsupported" */
  permission: string;
  /** iOS の本物のブラウザなら true。アプリ内蔵の WebView では false */
  standalone: boolean;
  /** 見えている音声入力デバイスの数。-1 は取得できなかったことを表す */
  audioInputs: number;
}

/**
 * 音声入力デバイスの数を数える。
 * 端末側でマイクが禁止されている（スクリーンタイムの制限など）と
 * 0 件になることがあり、「許可画面が出ないまま失敗する」ケースの手がかりになる。
 * ブラウザによって権限取得前の挙動が違うため、判定には使わず記録だけする。
 */
async function countAudioInputs(): Promise<number> {
  try {
    if (!navigator.mediaDevices?.enumerateDevices) return -1;
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === "audioinput").length;
  } catch {
    return -1;
  }
}

/** マイク権限の状態。Safari では未対応のこともあるので必ず握りつぶす */
async function readMicPermissionState(): Promise<string> {
  try {
    const permissions = navigator.permissions;
    if (!permissions?.query) return "unsupported";
    const status = await permissions.query({
      name: "microphone" as PermissionName,
    });
    return status.state;
  } catch {
    return "unsupported";
  }
}

/**
 * 保存ファイルに付ける録音情報。VoiceScan の一覧で形式の確認や
 * 「結果がおかしい」ときの切り分け（音声処理がかかっていないか等）に使う。
 */
function buildUploadMeta(
  result: AudioRecorderResult,
  track: TrackInfo | null,
  engine: string,
  device: string
): Record<string, string> {
  const bit = (v: boolean | null | undefined) => (v === true ? "1" : v === false ? "0" : "-");
  return {
    fmt: `vs${VOICESCAN_SAMPLE_RATE}-${VOICESCAN_RECORD_SEC}s`,
    srate: String(result.captureRate),
    mic: track?.sampleRate ? String(track.sampleRate) : "-",
    proc: `ec${bit(track?.echoCancellation)}ns${bit(track?.noiseSuppression)}agc${bit(track?.autoGainControl)}`,
    peak: result.peak.toFixed(3),
    clip: result.clipRatio.toFixed(4),
    snr: result.snrDb.toFixed(1),
    eng: engine,
    dev: device,
  };
}

function newUploadId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}


/**
 * 全画面ステップの外枠。
 *
 * 以前は Home コンポーネントの内側で定義していたため、state が変わるたびに
 * 「別のコンポーネント型」と見なされて中身が丸ごと作り直されていた。
 * その結果、入場アニメーションが毎回やり直しになり、マイクテストの
 * メーターが伸びずにちらつくだけになっていた。
 */
function FullScreenWrapper({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 bg-gray-950 flex flex-col items-center justify-center p-4 md:p-8 animate-fade-in overflow-y-auto">
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[400px] md:w-[600px] h-[400px] md:h-[600px] bg-blue-900/10 rounded-full blur-[100px] md:blur-[120px]" />
      </div>
      <div className="z-10 w-full max-w-lg flex flex-col items-center text-center my-auto">
        {children}
      </div>
    </div>
  );
}

function ConfirmButton({
  onClick,
  text = "確認しました",
}: {
  onClick: () => void;
  text?: string;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full max-w-sm py-4 md:py-5 bg-gradient-to-r from-blue-600 to-indigo-600 rounded-xl md:rounded-2xl font-bold text-lg md:text-xl hover:opacity-90 transition-all flex items-center justify-center gap-2 shadow-lg shadow-blue-900/30 hover:shadow-blue-900/50"
    >
      {text}
      <ArrowRight className="w-5 h-5 md:w-6 md:h-6" />
    </button>
  );
}

function CopyUrlButton({ copied, onCopy }: { copied: boolean; onCopy: () => void }) {
  return (
    <button
      onClick={onCopy}
      className="w-full max-w-sm py-3 bg-gray-800 rounded-xl font-medium text-base text-gray-200 hover:bg-gray-700 transition-colors flex items-center justify-center gap-2"
    >
      {copied ? (
        <>
          <Check className="w-5 h-5 text-green-400" />
          コピーしました
        </>
      ) : (
        <>
          <Copy className="w-5 h-5" />
          このページのURLをコピー
        </>
      )}
    </button>
  );
}

/**
 * LINEの内蔵ブラウザから標準ブラウザへ抜けるためのボタン。
 * openExternalBrowser=1 を付けたURLへ遷移するとLINEが外部ブラウザで開き直す。
 */
function ExternalBrowserButton() {
  return (
    <a
      href={externalBrowserUrl()}
      className="w-full max-w-sm py-4 bg-gradient-to-r from-cyan-600 to-blue-600 rounded-xl font-bold text-base md:text-lg text-white hover:opacity-90 transition-all flex items-center justify-center gap-2 shadow-lg shadow-cyan-900/30"
    >
      <ExternalLink className="w-5 h-5" />
      外部ブラウザで開き直す
    </a>
  );
}

export default function Home() {
  const [appState, setAppState] = useState<AppState>("intro");
  const [env, setEnv] = useState<EnvironmentInfo | null>(null);
  const [failure, setFailure] = useState<MicErrorInfo | null>(null);
  /** 問い合わせのときにスクリーンショットで送ってもらう診断文字列 */
  const [diagnostic, setDiagnostic] = useState<string>("");
  const [userName, setUserName] = useState<string>("");

  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);

  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [recordedDuration, setRecordedDuration] = useState<number>(0);
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [retryNotice, setRetryNotice] = useState<string>("");
  const [copied, setCopied] = useState<boolean>(false);
  /** 音割れなど「録り直し推奨だが送信もできる」失敗のときに true */
  const [canSendAnyway, setCanSendAnyway] = useState<boolean>(false);

  const recorderRef = useRef<AudioRecorder | null>(null);
  const stoppingRef = useRef<boolean>(false);
  const hardTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const uploadIdRef = useRef<string>("");
  const uploadMetaRef = useRef<Record<string, string>>({});
  const engineRef = useRef<string>("-");
  const progressBarRef = useRef<HTMLDivElement>(null);

  // デバイス・ブラウザ判定
  useEffect(() => {
    setEnv(detectEnvironment());
  }, []);

  const device = env?.device ?? "pc";

  // ---------------------------------------------------------------- リソース管理

  const releaseWakeLock = useCallback(() => {
    const lock = wakeLockRef.current;
    wakeLockRef.current = null;
    if (lock) void lock.release().catch(() => undefined);
  }, []);

  const requestWakeLock = useCallback(async () => {
    // 録音中に画面が消えるとAudioContextが止まるため、可能な端末では抑止する
    try {
      if (typeof navigator !== "undefined" && navigator.wakeLock) {
        wakeLockRef.current = await navigator.wakeLock.request("screen");
      }
    } catch {
      // 非対応・拒否された場合は何もしない
    }
  }, []);

  const disposeRecorder = useCallback(() => {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    setAnalyser(null);
    if (recorder) void recorder.dispose().catch(() => undefined);
  }, []);

  const clearHardTimeout = useCallback(() => {
    if (hardTimeoutRef.current) {
      clearTimeout(hardTimeoutRef.current);
      hardTimeoutRef.current = null;
    }
  }, []);

  // アンマウント時に必ずマイクと画面ロックを解放する
  useEffect(() => {
    return () => {
      clearHardTimeout();
      releaseWakeLock();
      const recorder = recorderRef.current;
      recorderRef.current = null;
      if (recorder) void recorder.dispose().catch(() => undefined);
    };
  }, [clearHardTimeout, releaseWakeLock]);

  // ---------------------------------------------------------------- 失敗ハンドリング

  const fail = useCallback(
    (info: MicErrorInfo, stage: string, detail?: string) => {
      clearHardTimeout();
      releaseWakeLock();
      disposeRecorder();
      setFailure(info);
      setDiagnostic(detail ?? "");
      setAppState("error");
      reportFailure({ stage, errorName: info.code, userName, detail });
    },
    [clearHardTimeout, releaseWakeLock, disposeRecorder, userName]
  );

  const failFromException = useCallback(
    (e: unknown, stage: string, diag?: MicAttemptDiagnostics) => {
      const info = describeMicError(e, device);
      const inApp = env?.inAppBrowser ?? null;
      const detailParts = [e instanceof Error ? e.message : String(e)];
      if (diag) {
        detailParts.push(
          `elapsed=${diag.elapsedMs}ms`,
          `permission=${diag.permission}`,
          `inApp=${inApp ?? "none"}`,
          `likelyInApp=${env?.likelyInAppBrowser ?? false}`,
          `standalone=${diag.standalone}`,
          `audioInputs=${diag.audioInputs}`
        );
      }
      const detail = detailParts.join(" / ");

      if (info.code === "NotAllowedError" || info.code === "Unsupported") {
        // 許可ダイアログが出ていれば、人がタップするまでに必ず時間がかかる。
        // 一瞬で拒否されたということは、ダイアログすら出ていない＝
        // アプリ内ブラウザなどブラウザ側の制限で塞がれている可能性が高い。
        const deniedBySetting = diag?.permission === "denied";
        const blockedByPlatform =
          !!inApp ||
          env?.likelyInAppBrowser === true ||
          (!deniedBySetting && diag !== undefined && diag.elapsedMs < 1200);

        if (blockedByPlatform) {
          const guide = getExternalBrowserGuide(inApp, device);
          // 原因は「アプリ内ブラウザ」と「端末側でマイクが禁止されている」の
          // 2通りある。どちらかを断定できないので、両方の手順を順番に出す。
          const deviceLevelHints =
            device === "ios"
              ? [
                "― Safariで開いているのにこの表示が出る場合 ―",
                "設定 → スクリーンタイム → コンテンツとプライバシーの制限 → マイク →「許可」",
                "設定 → Safari → マイク →「確認」",
                "上を直したら、Safariのタブを一度閉じてから開き直してください",
              ]
              : [
                "― ブラウザで直接開いているのにこの表示が出る場合 ―",
                "アドレスバーの🔒からマイクを「許可」に変更してください",
              ];

          fail(
            {
              code: info.code,
              title: "マイクの許可画面が出ませんでした",
              message:
                "許可を尋ねられないまま録音がブロックされました。LINEなどのアプリ内ブラウザで開いている場合と、端末側でマイクが禁止されている場合があります。",
              hints: [...guide.steps, ...deviceLevelHints],
              action: "externalBrowser",
            },
            stage,
            detail
          );
          return;
        }
      }

      fail(info, stage, detail);
    },
    [device, env, fail]
  );

  // ---------------------------------------------------------------- 画面遷移

  const nextStep = () => {
    if (appState === "intro") setAppState("privacy");
    else if (appState === "privacy") setAppState("step1");
    else if (appState === "step1") setAppState("step2");
    else if (appState === "step2") setAppState("step3");
    else if (appState === "step3") setAppState("nameInput");
  };

  const proceedToMicTest = () => {
    if (userName.trim().length > 0) {
      setAppState("micTest");
    }
  };

  /**
   * マイクを取得してオーディオグラフを組み立てる。
   * iOS Safari は AudioContext の生成・resume がユーザー操作の中で始まる必要があるため、
   * このハンドラから prepare() を呼ぶことが必須。ここで取得したマイクは
   * カウントダウン中も開いたままにし、録音開始時に取り直さない。
   */
  const requestMicPermissionAndProceed = async () => {
    disposeRecorder();
    const recorder = new AudioRecorder();
    recorderRef.current = recorder;
    const startedAt = Date.now();

    try {
      const prepared = await recorder.prepare();
      engineRef.current = prepared.engine;
      setAnalyser(prepared.analyser);
      setAppState("micReady");
      void requestWakeLock();
    } catch (e) {
      console.error("マイクの準備に失敗:", e);
      // 失敗の理由を切り分けるための材料を集める。
      // 許可ダイアログが出たかどうかは経過時間で推し量る。
      const diag: MicAttemptDiagnostics = {
        elapsedMs: Date.now() - startedAt,
        permission: await readMicPermissionState(),
        standalone: typeof navigator !== "undefined" && "standalone" in navigator,
        audioInputs: await countAudioInputs(),
      };
      failFromException(e, "マイク準備", diag);
    }
  };

  // マイクテスト中のレベルメーター。
  // 値の取得だけをここで提供し、描画は MicLevelMeter が requestAnimationFrame で行う。
  // 以前は 80ms ごとに setState していたため、画面全体が再描画され続けていた。
  const getMicMetrics = useCallback(
    (): MicMetrics | null => recorderRef.current?.getInputMetrics() ?? null,
    []
  );

  // ---------------------------------------------------------------- 録音

  const stopAndUpload = useCallback(async () => {
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    clearHardTimeout();

    const recorder = recorderRef.current;
    if (!recorder) {
      stoppingRef.current = false;
      return;
    }

    setAppState("uploading");
    setUploadProgress(0);
    setRetryNotice("");

    let result: AudioRecorderResult;
    try {
      result = await recorder.stop();
    } catch (e) {
      console.error("録音停止に失敗:", e);
      recorderRef.current = null;
      releaseWakeLock();
      setAnalyser(null);
      setFailure({
        code: errorNameOf(e),
        title: "録音データを取り出せませんでした",
        message: "お手数ですが、もう一度録音をお願いします。",
        hints: [],
        action: "retry",
      });
      setAppState("error");
      reportFailure({
        stage: "録音停止",
        errorName: errorNameOf(e),
        userName,
        detail: e instanceof Error ? e.message : undefined,
      });
      stoppingRef.current = false;
      return;
    }

    recorderRef.current = null;
    releaseWakeLock();
    setAnalyser(null);
    setRecordedBlob(result.blob);
    setRecordedDuration(result.duration);

    // --- ここから壊れた録音を弾くガード。以前は無音のWAVでも「保存完了」になっていた ---
    if (result.sampleCount === 0) {
      setFailure({
        code: result.interrupted ? "Interrupted" : "NoAudioData",
        title: "録音できませんでした",
        message: result.interrupted
          ? "録音中に画面の切り替えや着信があったため、音声を取得できませんでした。もう一度お試しください。"
          : "マイクから音声を取得できませんでした。もう一度お試しください。",
        hints: ["録音中は画面を切り替えず、そのままお待ちください"],
        action: "retry",
      });
      setAppState("error");
      reportFailure({ stage: "録音", errorName: "NoAudioData", userName });
      stoppingRef.current = false;
      return;
    }

    // VoiceScan は先頭約11.9秒を解析する。そこまで実音声で埋まっていないと結果が変わるので送らない
    if (!result.enoughForAnalysis) {
      setFailure({
        code: "TooShort",
        title: "録音が途中で止まりました",
        message: `${result.duration.toFixed(1)}秒しか録音できませんでした。録音中は画面を切り替えずにお待ちください。`,
        hints: [
          "他のアプリに切り替えない",
          "画面を消灯させない",
          "録音中にBluetoothイヤホンなどを接続・切断しない",
        ],
        action: "retry",
      });
      setAppState("error");
      reportFailure({
        stage: "録音",
        errorName: "TooShort",
        userName,
        detail: `duration=${result.duration.toFixed(2)}`,
      });
      stoppingRef.current = false;
      return;
    }

    if (result.peak < SILENCE_PEAK_THRESHOLD) {
      setFailure({
        code: "Silent",
        title: "マイクに音が入っていませんでした",
        message:
          "録音はできましたが、ほとんど音が入っていません。マイクを塞いでいないか確認して、もう一度お試しください。",
        hints: [
          "Bluetoothイヤホンを接続している場合は外す",
          "スマホ本体のマイク（画面下部）を手で塞がない",
          "マイクに向かって少し大きめの声で話す",
        ],
        action: "retry",
      });
      setAppState("error");
      reportFailure({
        stage: "録音",
        errorName: "Silent",
        userName,
        detail: `peak=${result.peak.toFixed(4)}`,
      });
      stoppingRef.current = false;
      return;
    }

    uploadMetaRef.current = buildUploadMeta(
      result,
      recorder.getTrackInfo(),
      engineRef.current,
      device
    );
    uploadIdRef.current = newUploadId();

    // 音割れ・雑音は解析結果を変えるので録り直しを勧める。ただし送信もできるようにする
    if (result.clipRatio >= CLIP_RATIO_THRESHOLD) {
      setFailure({
        code: "Clipped",
        title: "声が大きすぎて音が割れています",
        message:
          "このままでも送信できますが、分析の精度が下がります。スマホを口元から少し離して、もう一度録音することをおすすめします。",
        hints: [
          "スマホを口元から20〜30cmほど離す",
          "普段の会話くらいの声の大きさで話す",
          "マイク（スマホの下部）に息が直接当たらないようにする",
        ],
        action: "retry",
      });
      setCanSendAnyway(true);
      setAppState("error");
      reportFailure({
        stage: "録音",
        errorName: "Clipped",
        userName,
        detail: `clip=${result.clipRatio.toFixed(4)}`,
      });
      stoppingRef.current = false;
      return;
    }

    if (result.snrDb < MIN_SNR_DB) {
      setFailure({
        code: "Noisy",
        title: "周りの音に対して声が小さめです",
        message:
          "このままでも送信できますが、分析の精度が下がる可能性があります。静かな場所で、もう一度録音することをおすすめします。",
        hints: [
          "テレビ・エアコン・換気扇などの音が少ない場所で録音する",
          "スマホを口元から20〜30cmの位置に持つ",
          "普段の会話くらいの声ではっきり話す",
        ],
        action: "retry",
      });
      setCanSendAnyway(true);
      setAppState("error");
      reportFailure({
        stage: "録音",
        errorName: "Noisy",
        userName,
        detail: `snr=${result.snrDb.toFixed(1)}`,
      });
      stoppingRef.current = false;
      return;
    }
    // --- ガードここまで ---

    await sendToServer(result.blob, uploadIdRef.current);
    stoppingRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearHardTimeout, releaseWakeLock, userName, device]);

  const sendToServer = useCallback(
    async (blob: Blob, uploadId: string) => {
      setAppState("uploading");
      setUploadProgress(0);
      setRetryNotice("");

      try {
        await uploadRecording({
          blob,
          userName,
          uploadId,
          meta: uploadMetaRef.current,
          onProgress: setUploadProgress,
          onRetry: (attempt, max) => {
            setRetryNotice(`通信が不安定です。再送しています… (${attempt}/${max - 1})`);
          },
        });
        setRetryNotice("");
        setAppState("completed");
      } catch (e) {
        console.error("アップロードに失敗:", e);
        setRetryNotice("");
        setAppState("uploadFailed");
        reportFailure({
          stage: "サーバー送信",
          errorName: errorNameOf(e),
          userName,
          detail: e instanceof Error ? e.message : undefined,
        });
      }
    },
    [userName]
  );

  const startRecording = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || !recorder.isPrepared()) {
      setFailure({
        code: "NotPrepared",
        title: "録音を開始できませんでした",
        message: "マイクの準備が完了していません。もう一度お試しください。",
        hints: [],
        action: "retry",
      });
      setAppState("error");
      return;
    }

    stoppingRef.current = false;
    setAppState("recording");

    // 締め切りは壁時計ではなく実サンプル数で判定する。
    // 以前は state を切り替えた瞬間から10秒を数えていたため、
    // マイクが生きるまでの待ち時間の分だけ録音が短くなっていた。
    // 取り込む長さは VoiceScan の 12 秒設定の録音と同じ（約13.1秒）。
    recorder.beginCapture(() => {
      void stopAndUpload();
    });

    // 万一コールバックが来なかった場合の保険
    hardTimeoutRef.current = setTimeout(() => {
      void stopAndUpload();
    }, RECORDING_HARD_TIMEOUT_MS);
  }, [stopAndUpload]);

  // 録音の進み具合をバーに反映し、マイクからの音声が止まったら早めに打ち切る。
  // バーは実際に取り込めたサンプル数で動かす（以前はCSSアニメーションで、
  // マイクの立ち上がりが遅れても止まっても進んで見えていた）。
  useEffect(() => {
    if (appState !== "recording") return;
    const startedAt = performance.now();
    let raf = 0;
    const tick = () => {
      const recorder = recorderRef.current;
      if (!recorder || stoppingRef.current) return;
      const { ratio, lastDataAt } = recorder.getCaptureProgress();
      if (progressBarRef.current) {
        progressBarRef.current.style.width = `${(ratio * 100).toFixed(1)}%`;
      }
      const now = performance.now();
      const silentFor = lastDataAt > 0 ? now - lastDataAt : now - startedAt;
      // 立ち上がりは少し待つ。止まった場合は取れた分で判定する（足りなければ録り直し案内）
      if (silentFor > RECORDING_STALL_MS + (lastDataAt > 0 ? 0 : 2_000)) {
        void stopAndUpload();
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [appState, stopAndUpload]);

  // 録音・保存の途中でページを閉じたり再読み込みしたりしないよう確認を出す
  useEffect(() => {
    if (appState !== "countdown" && appState !== "recording" && appState !== "uploading") return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [appState]);

  // 録音中に他アプリ・ホーム画面へ移ると音声が途切れるため中断する
  useEffect(() => {
    if (appState !== "countdown" && appState !== "recording") return;

    const onVisibilityChange = () => {
      if (!document.hidden) return;
      if (stoppingRef.current) return;
      stoppingRef.current = true;
      clearHardTimeout();
      releaseWakeLock();
      disposeRecorder();
      setFailure({
        code: "Interrupted",
        title: "録音を中断しました",
        message:
          "録音中に画面が切り替わりました。録音が始まったら、終わるまでこの画面を表示したままお待ちください。",
        hints: ["他のアプリに切り替えない", "画面を消灯させない"],
        action: "retry",
      });
      setAppState("error");
      reportFailure({ stage: "録音", errorName: "Interrupted", userName });
      stoppingRef.current = false;
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [appState, clearHardTimeout, releaseWakeLock, disposeRecorder, userName]);

  // ---------------------------------------------------------------- ダウンロード / 共有

  const downloadName = useMemo(
    () => `${userName.trim() || "voice"}_${new Date().toISOString().slice(0, 10)}.wav`,
    [userName]
  );

  const blobUrl = useMemo(
    () => (recordedBlob ? URL.createObjectURL(recordedBlob) : null),
    [recordedBlob]
  );

  useEffect(() => {
    // レンダーのたびにURLを作って捨てていたリークを解消する
    return () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [blobUrl]);

  const shareFile = useMemo(() => {
    if (!recordedBlob) return null;
    try {
      return new File([recordedBlob], downloadName, { type: "audio/wav" });
    } catch {
      return null;
    }
  }, [recordedBlob, downloadName]);

  const canShare = useMemo(() => {
    if (!shareFile || typeof navigator === "undefined" || !navigator.canShare) return false;
    try {
      return navigator.canShare({ files: [shareFile] });
    } catch {
      return false;
    }
  }, [shareFile]);

  const shareRecording = async () => {
    if (!shareFile) return;
    try {
      await navigator.share({
        files: [shareFile],
        title: `${userName}さんの声紋録音`,
      });
    } catch {
      // ユーザーがキャンセルした場合など。ダウンロードボタンが併置されているので何もしない
    }
  };

  const copyPageUrl = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // クリップボードが使えない環境ではURLをそのまま読んでもらう
    }
  };

  // ---------------------------------------------------------------- やり直し

  const retryRecording = () => {
    clearHardTimeout();
    releaseWakeLock();
    disposeRecorder();
    stoppingRef.current = false;
    setFailure(null);
    setDiagnostic("");
    setCanSendAnyway(false);
    setRecordedBlob(null);
    setRecordedDuration(0);
    setUploadProgress(0);
    setRetryNotice("");
    setAppState("micTest");
  };

  const resetApp = () => {
    clearHardTimeout();
    releaseWakeLock();
    disposeRecorder();
    stoppingRef.current = false;
    setFailure(null);
    setDiagnostic("");
    setCanSendAnyway(false);
    setRecordedBlob(null);
    setRecordedDuration(0);
    setUploadProgress(0);
    setRetryNotice("");
    setUserName("");
    setAppState("intro");
  };

  const retryUpload = () => {
    if (!recordedBlob) return;
    if (!uploadIdRef.current) uploadIdRef.current = newUploadId();
    void sendToServer(recordedBlob, uploadIdRef.current);
  };

  /** 音割れの警告を受けたうえで、そのまま送信する */
  const sendAnyway = () => {
    if (!recordedBlob) return;
    setCanSendAnyway(false);
    setFailure(null);
    retryUpload();
  };

  // ---------------------------------------------------------------- 表示部品

  const permissionGuide = useMemo(() => {
    if (device === "ios") {
      return {
        icon: <Smartphone className="w-8 h-8 md:w-10 md:h-10" />,
        title: "iPhone / iPad",
        steps: [
          "ポップアップで「許可」をタップ",
          "許可画面が出ない場合：",
          "設定 → Safari → マイク → 許可",
        ],
      };
    }
    if (device === "android") {
      return {
        icon: <Smartphone className="w-8 h-8 md:w-10 md:h-10" />,
        title: "Android",
        steps: [
          "ポップアップで「許可」をタップ",
          "許可画面が出ない場合：",
          "設定 → アプリ → ブラウザ → 権限 → マイク → 許可",
        ],
      };
    }
    return {
      icon: <Monitor className="w-8 h-8 md:w-10 md:h-10" />,
      title: "パソコン",
      steps: [
        "アドレスバー左の🔒アイコンをクリック",
        "「マイク」を「許可」に変更",
        "ページを再読み込み",
      ],
    };
  }, [device]);

  const DownloadAndShare = ({ tone }: { tone: "blue" | "red" }) => (
    <div className="w-full max-w-sm space-y-3">
      {canShare && (
        <button
          onClick={shareRecording}
          className="w-full py-4 bg-gradient-to-r from-green-600 to-emerald-600 rounded-xl font-bold text-lg hover:opacity-90 transition-all flex items-center justify-center gap-2 shadow-lg shadow-green-900/30"
        >
          <Share2 className="w-5 h-5" />
          録音を送る（LINEなど）
        </button>
      )}
      {blobUrl && (
        <a
          href={blobUrl}
          download={downloadName}
          className={cn(
            "flex items-center justify-center gap-2 w-full py-4 rounded-xl font-bold text-lg transition-all shadow-lg",
            tone === "blue"
              ? "bg-gradient-to-r from-blue-600 to-indigo-600 hover:opacity-90 shadow-blue-900/30"
              : "bg-blue-600 hover:bg-blue-700"
          )}
        >
          <Download className="w-5 h-5" />
          録音をダウンロード
        </a>
      )}
    </div>
  );

  // ---------------------------------------------------------------- 非対応環境

  // 機能自体が無い環境（アプリ内WebView・http接続など）は最初に止める
  if (env && !env.canRecord) {
    const guide = env.inAppBrowser
      ? getExternalBrowserGuide(env.inAppBrowser, env.device)
      : {
          title: "このブラウザでは録音できません",
          steps: [
            "Safari（iPhone）または Chrome（Android）で開いてください",
            "URLをコピーしてブラウザのアドレスバーに貼り付けてください",
          ],
        };

    return (
      <main className="min-h-screen bg-gray-950 text-white flex flex-col items-center justify-center p-4">
        <div className="w-full max-w-lg flex flex-col items-center text-center space-y-6">
          <ExternalLink className="w-16 h-16 text-yellow-400" />
          <h2 className="text-2xl md:text-3xl font-bold text-yellow-400">{guide.title}</h2>
          <div className="w-full bg-gray-900/50 rounded-2xl p-6 border border-gray-800 text-left space-y-3">
            {guide.steps.map((step, i) => (
              <div key={i} className="flex items-start gap-3">
                <span className="text-yellow-400 font-bold">{i + 1}.</span>
                <p className="text-sm md:text-base text-gray-300">{step}</p>
              </div>
            ))}
          </div>
          {!env.isSecure && (
            <p className="text-sm text-red-400">
              安全な接続（https）で開く必要があります。
            </p>
          )}
          {env.isSecure && <ExternalBrowserButton />}
          <CopyUrlButton copied={copied} onCopy={copyPageUrl} />
        </div>
      </main>
    );
  }

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

          {/* アプリ内ブラウザは録音に失敗しやすいので先に警告する。
              UAにアプリ名が出ない内蔵ブラウザ（LINEのiOS版など）も拾う */}
          {(env?.inAppBrowser || env?.likelyInAppBrowser) && (
            <div className="w-full max-w-sm bg-yellow-900/30 border border-yellow-700/50 rounded-xl p-4 mb-6 text-left space-y-3">
              <p className="text-sm text-yellow-300 font-medium flex items-start gap-2">
                <ExternalLink className="w-5 h-5 flex-shrink-0 mt-0.5" />
                このままでは録音できない可能性があります
              </p>
              <div className="space-y-1">
                {getExternalBrowserGuide(env.inAppBrowser, env.device).steps.map((s, i) => (
                  <p key={i} className="text-xs text-yellow-200/80">
                    {i + 1}. {s}
                  </p>
                ))}
              </div>
              <ExternalBrowserButton />
              <CopyUrlButton copied={copied} onCopy={copyPageUrl} />
            </div>
          )}

          <ConfirmButton onClick={nextStep} text="はじめる" />

          <div className="absolute bottom-4 md:bottom-6 left-0 right-0 text-center text-xs md:text-sm text-gray-600">
            © 声紋診断アップデート林
          </div>
        </FullScreenWrapper>
      )}

      {/* State: PRIVACY */}
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

      {/* State: NAME INPUT */}
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

      {/* State: MIC TEST（許可を取る前） */}
      {appState === "micTest" && (
        <FullScreenWrapper>
          <h2 className="text-2xl md:text-4xl font-bold text-white mb-6 md:mb-8">
            マイクの許可
          </h2>

          <div className="w-full space-y-6 md:space-y-8">
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

            <button
              onClick={requestMicPermissionAndProceed}
              className="w-full max-w-sm mx-auto py-4 md:py-5 bg-gradient-to-r from-cyan-600 to-blue-600 rounded-xl md:rounded-2xl font-bold text-lg md:text-xl hover:opacity-90 transition-all flex items-center justify-center gap-2 shadow-lg shadow-cyan-900/30"
            >
              <Mic className="w-5 h-5 md:w-6 md:h-6" />
              マイクを許可する
            </button>

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

      {/* State: MIC READY（許可済み・音量確認） */}
      {appState === "micReady" && (
        <FullScreenWrapper>
          <div className="flex items-center justify-center gap-2 text-green-400 mb-4">
            <CheckCircle2 className="w-6 h-6" />
            <span className="font-medium">マイクを使用できます</span>
          </div>
          <h2 className="text-2xl md:text-3xl font-bold text-white mb-4">
            声が届いているか確認
          </h2>
          <p className="text-sm md:text-base text-gray-400 mb-6">
            「あー」と声を出して、下のバーが動くことを確認してください
          </p>

          <div className="w-full flex justify-center mb-6">
            <MicLevelMeter getMetrics={getMicMetrics} active={appState === "micReady"} />
          </div>

          <button
            onClick={() => setAppState("countdown")}
            className="w-full max-w-sm py-4 md:py-5 bg-gradient-to-r from-blue-600 to-indigo-600 rounded-xl md:rounded-2xl font-bold text-lg md:text-xl hover:opacity-90 transition-all flex items-center justify-center gap-2 shadow-lg shadow-blue-900/30"
          >
            録音を開始する
            <ArrowRight className="w-5 h-5 md:w-6 md:h-6" />
          </button>

          <p className="text-sm text-cyan-400/80 mt-4">
            ※ <span className="font-bold">3→2→1</span> のカウントダウンのあと、
            約{RECORDING_DISPLAY_SEC}秒間録音します
          </p>
          <p className="text-xs text-yellow-400/80 mt-2">
            録音が終わるまで、他のアプリに切り替えないでください
          </p>
        </FullScreenWrapper>
      )}

      <div className="z-10 w-full max-w-md flex flex-col items-center space-y-6 md:space-y-8">
        {/* Header（メイン画面用） */}
        {!["intro", "privacy", "step1", "step2", "step3", "micTest", "micReady"].includes(
          appState
        ) && (
          <h1 className="text-2xl md:text-4xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-purple-400">
            声紋診断レコーダー
          </h1>
        )}

        {/* State: COUNTDOWN */}
        {appState === "countdown" && <GlowCountdown onComplete={startRecording} />}

        {/* State: RECORDING */}
        {appState === "recording" && (
          <div className="w-full flex flex-col items-center space-y-6">
            <div className="text-cyan-400 font-medium text-lg md:text-xl animate-pulse">
              フルネームを繰り返し言ってください。
            </div>
            {analyser && <AudioVisualizer analyser={analyser} isRecording={true} />}
            <div className="w-full h-3 md:h-4 bg-gray-800 rounded-full overflow-hidden">
              <div ref={progressBarRef} className="h-full bg-cyan-500" style={{ width: "0%" }} />
            </div>
            <p className="text-sm text-gray-400">
              バーが右端に届くまで（約{RECORDING_DISPLAY_SEC}秒）続けてください
            </p>
            <p className="text-xs text-yellow-400/80">
              他のアプリに切り替えないでください
            </p>
          </div>
        )}

        {/* State: UPLOADING */}
        {appState === "uploading" && (
          <div className="flex flex-col items-center space-y-4 md:space-y-6 w-full">
            <Loader2 className="w-16 h-16 md:w-20 md:h-20 text-blue-500 animate-spin" />
            <p className="text-lg md:text-2xl font-medium">保存中...</p>
            <div className="w-full max-w-sm h-3 bg-gray-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-500 transition-[width] duration-200"
                style={{ width: `${Math.round(uploadProgress * 100)}%` }}
              />
            </div>
            <p className="text-sm md:text-base text-gray-500">
              {Math.round(uploadProgress * 100)}%
            </p>
            {retryNotice && (
              <p className="text-sm text-yellow-400 animate-pulse">{retryNotice}</p>
            )}
            <p className="text-xs text-red-400 animate-pulse">
              ⚠️ 完了するまでブラウザを閉じないでください
            </p>
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

            <div className="w-full max-w-sm bg-green-900/30 border border-green-700/50 rounded-xl p-4 text-center">
              <p className="text-green-300 font-medium text-base md:text-lg">
                ✓ このままブラウザを閉じてOKです
              </p>
            </div>

            <p className="text-xs md:text-sm text-gray-500 text-center">
              ※ 音声データは分析完了後、速やかに削除いたします
            </p>

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

            <div className="text-xs text-gray-600 mt-4">© 声紋診断アップデート林</div>
          </div>
        )}

        {/* State: UPLOAD FAILED - 保存できなかったことを正直に伝える */}
        {appState === "uploadFailed" && (
          <div className="flex flex-col items-center space-y-6 bg-yellow-950/20 p-8 md:p-10 rounded-3xl border border-yellow-900/50">
            <AlertCircle className="w-20 h-20 md:w-24 md:h-24 text-yellow-500" />
            <div className="text-center">
              <h2 className="text-xl md:text-2xl font-bold text-yellow-400 mb-2">
                サーバーに保存できませんでした
              </h2>
              <p className="text-gray-300 text-base md:text-lg">
                録音自体は成功しています（{recordedDuration.toFixed(1)}秒）。<br />
                下のボタンで録音データを保存し、<br />
                公式LINEでアップデート林にお送りください。
              </p>
            </div>

            <DownloadAndShare tone="blue" />

            <div className="w-full max-w-sm space-y-3 pt-4 border-t border-gray-800">
              <button
                onClick={retryUpload}
                className="w-full py-3 bg-gray-700 rounded-xl text-sm font-medium text-gray-200 hover:bg-gray-600 transition-colors flex items-center justify-center gap-2"
              >
                <RefreshCw className="w-4 h-4" />
                もう一度サーバーに送信する
              </button>
              <button
                onClick={retryRecording}
                className="w-full py-2 bg-gray-800 rounded-lg text-sm text-gray-400 hover:bg-gray-700 transition-colors"
              >
                録音し直す
              </button>
            </div>

            <div className="text-xs text-gray-600 mt-2">© 声紋診断アップデート林</div>
          </div>
        )}

        {/* State: ERROR */}
        {appState === "error" && (
          <div className="flex flex-col items-center space-y-6 bg-red-950/20 p-8 md:p-10 rounded-3xl border border-red-900/50">
            <AlertCircle className="w-20 h-20 md:w-24 md:h-24 text-red-500" />
            <div className="text-center">
              <h2 className="text-xl md:text-2xl font-bold text-red-400 mb-2">
                {failure?.title ?? "エラーが発生しました"}
              </h2>
              <p className="text-gray-300 text-base md:text-lg">
                {failure?.message ?? "不明なエラーです"}
              </p>
            </div>

            {failure?.hints && failure.hints.length > 0 && (
              <div className="w-full max-w-sm bg-gray-900/50 rounded-xl p-4 border border-gray-800 text-left space-y-2">
                {failure.hints.map((hint, i) => (
                  <p key={i} className="text-sm text-gray-300 flex items-start gap-2">
                    <span className="text-cyan-400">・</span>
                    {hint}
                  </p>
                ))}
              </div>
            )}

            {failure?.action === "externalBrowser" && (
              <div className="w-full max-w-sm space-y-3">
                <ExternalBrowserButton />
                <CopyUrlButton copied={copied} onCopy={copyPageUrl} />
              </div>
            )}

            {/* 録音が取れている場合のみ、手元に保存する手段を出す */}
            {!canSendAnyway && recordedBlob && recordedDuration >= 3 && (
              <div className="w-full max-w-sm space-y-3">
                <p className="text-sm text-yellow-400 text-center">
                  録音データは手元に残っています
                </p>
                <DownloadAndShare tone="red" />
              </div>
            )}

            {failure?.action !== "none" && (
              <button
                onClick={retryRecording}
                className="w-full max-w-sm py-4 bg-red-600 rounded-xl font-bold text-lg hover:bg-red-700 transition-colors"
              >
                もう一度試す
              </button>
            )}

            {canSendAnyway && recordedBlob && (
              <button
                onClick={sendAnyway}
                className="w-full max-w-sm py-3 bg-gray-700 rounded-xl text-sm font-medium text-gray-200 hover:bg-gray-600 transition-colors"
              >
                このまま送信する
              </button>
            )}

            <button
              onClick={resetApp}
              className="text-sm text-gray-500 hover:text-gray-300 transition-colors"
            >
              最初からやり直す
            </button>

            {failure?.code && (
              <div className="w-full max-w-sm text-center space-y-1">
                <p className="text-[10px] text-gray-600">
                  エラーコード: {failure.code}
                </p>
                {diagnostic && (
                  <>
                    <p className="text-[10px] text-gray-600">
                      解決しない場合は、この画面のスクリーンショットをお送りください
                    </p>
                    <p className="text-[10px] text-gray-700 break-all select-all">
                      {diagnostic}
                    </p>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
