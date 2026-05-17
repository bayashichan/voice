"use client";

import { useState, useEffect, useRef } from "react";
import { Play, Pause, Download, RefreshCw, Lock, Music, Clock, User, Loader2, AlertCircle, Trash2 } from "lucide-react";
import { GAS_WEB_APP_URL, ADMIN_PASSWORD } from "@/utils/config";

// ---- 型定義 ----
interface RecordingFile {
  id: string;
  name: string;
  size: number;
  createdAt: string;
  url: string;
}

// ---- ユーティリティ ----
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("ja-JP", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

// ファイル名からユーザー名を抽出（形式: ユーザー名_yyyyMMdd_HHmmss.wav）
function extractUserName(fileName: string): string {
  const match = fileName.match(/^(.+?)_\d{8}_\d{6}\.wav$/);
  return match ? match[1] : fileName.replace(".wav", "");
}

// ---- 再生コンポーネント ----
function AudioPlayer({ file, gasUrl }: { file: RecordingFile; gasUrl: string }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const blobUrlRef = useRef<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState(false);

  // GAS経由でBase64音声を取得してBlobURLを作成する（CORSを回避）
  const loadAudio = async (): Promise<HTMLAudioElement> => {
    if (audioRef.current) return audioRef.current;

    const res = await fetch(`${gasUrl}?action=audio&id=${file.id}`);
    const data = await res.json() as { result: string; base64?: string; mimeType?: string; message?: string };
    if (data.result !== "success" || !data.base64) throw new Error(data.message || "音声取得失敗");

    const binary = atob(data.base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: data.mimeType || "audio/wav" });
    const blobUrl = URL.createObjectURL(blob);
    blobUrlRef.current = blobUrl;

    const audio = new Audio(blobUrl);
    audio.onloadedmetadata = () => setDuration(audio.duration);
    audio.ontimeupdate = () => {
      if (audio.duration > 0) setProgress((audio.currentTime / audio.duration) * 100);
    };
    audio.onended = () => { setIsPlaying(false); setProgress(0); };
    audio.onerror = () => { setError(true); setIsPlaying(false); };
    audioRef.current = audio;
    return audio;
  };

  const handlePlayPause = async () => {
    if (error || loading) return;

    if (isPlaying) {
      audioRef.current?.pause();
      setIsPlaying(false);
      return;
    }

    try {
      setLoading(true);
      const audio = await loadAudio();
      await audio.play();
      setIsPlaying(true);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      audioRef.current = null;
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    };
  }, []);

  return (
    <div className="flex items-center gap-3 w-full">
      <button
        onClick={handlePlayPause}
        disabled={error || loading}
        className={`flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center transition-all ${
          error ? "bg-red-900/40 text-red-400 cursor-not-allowed"
          : loading ? "bg-gray-700 text-gray-400 cursor-wait"
          : "bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-900/30"
        }`}
      >
        {error ? (
          <AlertCircle className="w-4 h-4" />
        ) : loading ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : isPlaying ? (
          <Pause className="w-4 h-4" />
        ) : (
          <Play className="w-4 h-4 ml-0.5" />
        )}
      </button>

      <div className="flex-1 min-w-0">
        <div className="w-full h-1.5 bg-gray-700 rounded-full overflow-hidden">
          <div
            className="h-full bg-blue-500 rounded-full transition-all"
            style={{ width: `${progress}%` }}
          />
        </div>
        {duration > 0 && (
          <p className="text-xs text-gray-500 mt-1">
            {Math.floor(duration / 60)}:{String(Math.floor(duration % 60)).padStart(2, "0")}
          </p>
        )}
        {loading && <p className="text-xs text-gray-500 mt-1">読み込み中...</p>}
        {error && <p className="text-xs text-red-400 mt-1">音声の読み込みに失敗しました</p>}
      </div>

      <a
        href={`https://drive.google.com/uc?export=download&id=${file.id}`}
        download={file.name}
        className="flex-shrink-0 p-2 rounded-lg hover:bg-gray-700 text-gray-400 hover:text-white transition-colors"
        title="ダウンロード"
      >
        <Download className="w-4 h-4" />
      </a>
    </div>
  );
}

// ---- メイン管理画面 ----
export default function AdminPage() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState(false);

  const [files, setFiles] = useState<RecordingFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState("");
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const gasUrl = GAS_WEB_APP_URL;

  // ---- 認証 ----
  const handleLogin = () => {
    if (password === ADMIN_PASSWORD) {
      setIsAuthenticated(true);
      setPasswordError(false);
    } else {
      setPasswordError(true);
    }
  };

  // ---- ファイル一覧取得 ----
  const fetchFiles = async () => {
    if (!gasUrl) {
      setFetchError("GAS URLが設定されていません。utils/config.ts を確認してください。");
      return;
    }
    setLoading(true);
    setFetchError("");
    try {
      const res = await fetch(`${gasUrl}?action=list`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { result: string; files?: RecordingFile[]; message?: string };
      if (data.result === "success") {
        setFiles(data.files || []);
        setLastUpdated(new Date());
      } else {
        throw new Error(data.message || "取得失敗");
      }
    } catch (e) {
      setFetchError(`録音一覧の取得に失敗しました: ${e instanceof Error ? e.message : "不明なエラー"}`);
    } finally {
      setLoading(false);
    }
  };

  // ---- ファイル削除 ----
  const handleDelete = async (file: RecordingFile) => {
    if (!confirm(`「${extractUserName(file.name)}」の録音データを削除しますか？\n（Googleドライブのゴミ箱に移動されます）`)) return;
    setDeletingId(file.id);
    try {
      const res = await fetch(`${gasUrl}?action=delete&id=${file.id}`);
      const data = await res.json() as { result: string; message?: string };
      if (data.result === "success") {
        setFiles(prev => prev.filter(f => f.id !== file.id));
      } else {
        alert(`削除失敗: ${data.message}`);
      }
    } catch {
      alert("削除中にエラーが発生しました");
    } finally {
      setDeletingId(null);
    }
  };

  useEffect(() => {
    if (isAuthenticated) fetchFiles();
  }, [isAuthenticated]);

  // ---- ログイン画面 ----
  if (!isAuthenticated) {
    return (
      <main className="min-h-screen bg-gray-950 text-white flex items-center justify-center p-4">
        <div className="w-full max-w-sm">
          <div className="flex items-center justify-center gap-3 mb-8">
            <Lock className="w-8 h-8 text-blue-400" />
            <h1 className="text-2xl font-bold text-white">管理画面</h1>
          </div>

          <div className="bg-gray-900 rounded-2xl p-6 border border-gray-800 space-y-4">
            <div>
              <label className="block text-sm text-gray-400 mb-2">パスワード</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleLogin()}
                placeholder="パスワードを入力"
                autoFocus
                className={`w-full px-4 py-3 bg-gray-800 border rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 transition-all ${
                  passwordError
                    ? "border-red-500 focus:ring-red-500/30"
                    : "border-gray-700 focus:ring-blue-500/30 focus:border-blue-500"
                }`}
              />
              {passwordError && (
                <p className="text-red-400 text-sm mt-2">パスワードが違います</p>
              )}
            </div>
            <button
              onClick={handleLogin}
              className="w-full py-3 bg-gradient-to-r from-blue-600 to-indigo-600 rounded-xl font-bold hover:opacity-90 transition-opacity"
            >
              ログイン
            </button>
          </div>
        </div>
      </main>
    );
  }

  // ---- 管理画面本体 ----
  return (
    <main className="min-h-screen bg-gray-950 text-white p-4 md:p-8">
      {/* 背景装飾 */}
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-blue-900/10 rounded-full blur-[120px]" />
        <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-purple-900/10 rounded-full blur-[120px]" />
      </div>

      <div className="relative z-10 max-w-4xl mx-auto">
        {/* ヘッダー */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-purple-400">
              録音データ管理
            </h1>
            <p className="text-gray-500 text-sm mt-1">声紋診断アップデート林 管理画面</p>
          </div>
          <button
            onClick={fetchFiles}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded-xl text-sm transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            更新
          </button>
        </div>

        {/* 統計バー */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-6">
          <div className="bg-gray-900/50 border border-gray-800 rounded-xl p-4">
            <p className="text-gray-400 text-xs mb-1">録音件数</p>
            <p className="text-2xl font-bold text-white">{files.length}</p>
          </div>
          <div className="bg-gray-900/50 border border-gray-800 rounded-xl p-4">
            <p className="text-gray-400 text-xs mb-1">合計サイズ</p>
            <p className="text-2xl font-bold text-white">
              {formatBytes(files.reduce((sum, f) => sum + f.size, 0))}
            </p>
          </div>
          <div className="bg-gray-900/50 border border-gray-800 rounded-xl p-4 col-span-2 md:col-span-1">
            <p className="text-gray-400 text-xs mb-1">最終更新</p>
            <p className="text-sm font-medium text-white">
              {lastUpdated ? lastUpdated.toLocaleTimeString("ja-JP") : "—"}
            </p>
          </div>
        </div>

        {/* エラー */}
        {fetchError && (
          <div className="flex items-start gap-3 bg-red-950/30 border border-red-800/50 rounded-xl p-4 mb-6">
            <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
            <p className="text-red-300 text-sm">{fetchError}</p>
          </div>
        )}

        {/* ローディング */}
        {loading && files.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-gray-500">
            <Loader2 className="w-10 h-10 animate-spin mb-4 text-blue-500" />
            <p>録音データを取得中...</p>
          </div>
        )}

        {/* ファイルなし */}
        {!loading && !fetchError && files.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-gray-600">
            <Music className="w-12 h-12 mb-4 text-gray-700" />
            <p className="text-lg font-medium text-gray-500">録音データがありません</p>
            <p className="text-sm mt-1">録音すると、ここに一覧が表示されます</p>
          </div>
        )}

        {/* 録音一覧 */}
        {files.length > 0 && (
          <div className="space-y-3">
            {files.map((file) => (
              <div
                key={file.id}
                className="bg-gray-900/60 border border-gray-800 rounded-xl p-4 md:p-5 hover:border-gray-700 transition-colors"
              >
                <div className="flex flex-col md:flex-row md:items-center gap-4">
                  {/* 情報 */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <User className="w-4 h-4 text-blue-400 flex-shrink-0" />
                      <p className="font-medium text-white truncate">
                        {extractUserName(file.name)}
                      </p>
                    </div>
                    <div className="flex items-center gap-4 text-xs text-gray-500">
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {formatDate(file.createdAt)}
                      </span>
                      <span>{formatBytes(file.size)}</span>
                    </div>
                  </div>

                  {/* プレーヤー + 削除 */}
                  <div className="flex items-center gap-2 md:w-72">
                    <div className="flex-1">
                      <AudioPlayer file={file} gasUrl={gasUrl} />
                    </div>
                    <button
                      onClick={() => handleDelete(file)}
                      disabled={deletingId === file.id}
                      className="flex-shrink-0 p-2 rounded-lg hover:bg-red-900/30 text-gray-600 hover:text-red-400 transition-colors disabled:opacity-40"
                      title="削除（ゴミ箱へ）"
                    >
                      {deletingId === file.id
                        ? <Loader2 className="w-4 h-4 animate-spin" />
                        : <Trash2 className="w-4 h-4" />
                      }
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        <p className="text-center text-xs text-gray-700 mt-8">
          © 声紋診断アップデート林 — 管理画面
        </p>
      </div>
    </main>
  );
}
