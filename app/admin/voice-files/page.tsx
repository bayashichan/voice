"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Trash2, Download, RefreshCw, Lock, FileAudio, AlertCircle, Play, Square, LogOut } from "lucide-react";
import { WORKERS_API_URL } from "@/utils/config";

interface AudioFile {
    name: string;
    size: number;
    uploaded: string;
}

const TOKEN_STORAGE_KEY = "voice-admin-token";

export default function AdminPage() {
    const [isAuthenticated, setIsAuthenticated] = useState(false);
    const [password, setPassword] = useState("");
    // 入力されたパスワードをそのままAPIトークンとして使う。
    // 以前は config.ts の定数を参照していたため、パスワードが
    // 全訪問者に配信されるJSバンドルに埋め込まれていた。
    const [token, setToken] = useState("");
    const [files, setFiles] = useState<AudioFile[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
    const [playingFile, setPlayingFile] = useState<string | null>(null);
    const [audioUrl, setAudioUrl] = useState<string | null>(null);
    const audioRef = useRef<HTMLAudioElement>(null);

    const authHeaders = (t: string) => ({ Authorization: `Bearer ${t}` });

    // ファイル一覧取得
    const fetchFiles = useCallback(async (t: string) => {
        setLoading(true);
        setError("");
        try {
            const response = await fetch(`${WORKERS_API_URL}/list`, {
                headers: authHeaders(t),
            });
            if (response.status === 401) throw new Error("パスワードが正しくありません");
            if (!response.ok) throw new Error("ファイル一覧の取得に失敗しました");
            const data = await response.json() as { files: AudioFile[] };
            setFiles(data.files.sort((a, b) =>
                new Date(b.uploaded).getTime() - new Date(a.uploaded).getTime()
            ));
        } catch (e) {
            setError(e instanceof Error ? e.message : "エラーが発生しました");
            throw e;
        } finally {
            setLoading(false);
        }
    }, []);

    // 認証チェック（サーバーに問い合わせて判定する）
    const handleLogin = async () => {
        const entered = password.trim();
        if (!entered) {
            setError("パスワードを入力してください");
            return;
        }
        try {
            await fetchFiles(entered);
            setToken(entered);
            setIsAuthenticated(true);
            setPassword("");
            sessionStorage.setItem(TOKEN_STORAGE_KEY, entered);
        } catch {
            // fetchFiles 側でエラーメッセージを設定済み
        }
    };

    const handleLogout = () => {
        sessionStorage.removeItem(TOKEN_STORAGE_KEY);
        setToken("");
        setIsAuthenticated(false);
        setFiles([]);
        setSelectedFiles(new Set());
    };

    // タブを開いている間だけ再入力を省く
    useEffect(() => {
        const saved = sessionStorage.getItem(TOKEN_STORAGE_KEY);
        if (!saved) return;
        setToken(saved);
        setIsAuthenticated(true);
        void fetchFiles(saved).catch(() => {
            sessionStorage.removeItem(TOKEN_STORAGE_KEY);
            setToken("");
            setIsAuthenticated(false);
        });
    }, [fetchFiles]);

    // 音声プレビュー再生
    const playPreview = async (fileName: string) => {
        // 同じファイルを再度クリックした場合は停止
        if (playingFile === fileName) {
            stopPreview();
            return;
        }

        try {
            // 古いURLを解放
            if (audioUrl) {
                URL.revokeObjectURL(audioUrl);
            }

            const response = await fetch(`${WORKERS_API_URL}/download/${encodeURIComponent(fileName)}`, {
                headers: {
                    ...authHeaders(token),
                },
            });
            if (!response.ok) throw new Error("音声の取得に失敗しました");

            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            setAudioUrl(url);
            setPlayingFile(fileName);

            // 少し待ってから再生開始
            setTimeout(() => {
                if (audioRef.current) {
                    audioRef.current.play();
                }
            }, 100);
        } catch (e) {
            setError(e instanceof Error ? e.message : "プレビューエラー");
        }
    };

    // プレビュー停止
    const stopPreview = () => {
        if (audioRef.current) {
            audioRef.current.pause();
            audioRef.current.currentTime = 0;
        }
        if (audioUrl) {
            URL.revokeObjectURL(audioUrl);
        }
        setPlayingFile(null);
        setAudioUrl(null);
    };

    // 音声終了時のハンドラ
    const handleAudioEnded = () => {
        setPlayingFile(null);
    };

    // ファイルダウンロード
    const downloadFile = async (fileName: string) => {
        try {
            const response = await fetch(`${WORKERS_API_URL}/download/${encodeURIComponent(fileName)}`, {
                headers: {
                    ...authHeaders(token),
                },
            });
            if (!response.ok) throw new Error("ダウンロードに失敗しました");

            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (e) {
            setError(e instanceof Error ? e.message : "ダウンロードエラー");
        }
    };

    // ファイル削除
    const deleteFile = async (fileName: string) => {
        if (!confirm(`「${fileName}」を削除しますか？`)) return;

        // 再生中なら停止
        if (playingFile === fileName) {
            stopPreview();
        }

        try {
            const response = await fetch(`${WORKERS_API_URL}/delete/${encodeURIComponent(fileName)}`, {
                method: "DELETE",
                headers: {
                    ...authHeaders(token),
                },
            });
            if (!response.ok) throw new Error("削除に失敗しました");

            setFiles(files.filter(f => f.name !== fileName));
            setSelectedFiles(prev => {
                const next = new Set(prev);
                next.delete(fileName);
                return next;
            });
        } catch (e) {
            setError(e instanceof Error ? e.message : "削除エラー");
        }
    };

    // 選択したファイルを一括削除
    const deleteSelected = async () => {
        if (selectedFiles.size === 0) return;
        if (!confirm(`${selectedFiles.size}件のファイルを削除しますか？`)) return;

        stopPreview();

        for (const fileName of selectedFiles) {
            try {
                await fetch(`${WORKERS_API_URL}/delete/${encodeURIComponent(fileName)}`, {
                    method: "DELETE",
                    headers: {
                        ...authHeaders(token),
                    },
                });
            } catch (e) {
                console.error(e);
            }
        }
        setSelectedFiles(new Set());
        void fetchFiles(token).catch(() => undefined);
    };

    // ファイルサイズのフォーマット
    const formatSize = (bytes: number) => {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    };

    // 日時のフォーマット
    const formatDate = (isoString: string) => {
        const date = new Date(isoString);
        return date.toLocaleString("ja-JP", {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
        });
    };

    // 選択トグル
    const toggleSelect = (fileName: string) => {
        setSelectedFiles(prev => {
            const next = new Set(prev);
            if (next.has(fileName)) {
                next.delete(fileName);
            } else {
                next.add(fileName);
            }
            return next;
        });
    };

    // 全選択/解除
    const toggleSelectAll = () => {
        if (selectedFiles.size === files.length) {
            setSelectedFiles(new Set());
        } else {
            setSelectedFiles(new Set(files.map(f => f.name)));
        }
    };

    // ログイン画面
    if (!isAuthenticated) {
        return (
            <main className="min-h-screen bg-gray-950 text-white flex items-center justify-center p-4">
                <div className="w-full max-w-sm space-y-6">
                    <div className="text-center">
                        <Lock className="w-16 h-16 mx-auto text-blue-400 mb-4" />
                        <h1 className="text-2xl font-bold mb-2">管理画面</h1>
                        <p className="text-gray-400 text-sm">パスワードを入力してください</p>
                    </div>

                    {error && (
                        <div className="bg-red-900/30 border border-red-700 rounded-lg p-3 text-red-300 text-sm flex items-center gap-2">
                            <AlertCircle className="w-4 h-4" />
                            {error}
                        </div>
                    )}

                    <input
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") void handleLogin();
                        }}
                        placeholder="パスワード"
                        className="w-full px-4 py-3 bg-gray-900 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-blue-500"
                        autoFocus
                    />

                    <button
                        onClick={() => void handleLogin()}
                        disabled={loading}
                        className="w-full py-3 bg-blue-600 rounded-lg font-bold hover:bg-blue-700 transition-colors disabled:opacity-50"
                    >
                        {loading ? "確認中..." : "ログイン"}
                    </button>
                </div>
            </main>
        );
    }

    // 管理画面
    return (
        <main className="min-h-screen bg-gray-950 text-white p-4 md:p-8">
            {/* 隠しオーディオ要素 */}
            <audio
                ref={audioRef}
                src={audioUrl || undefined}
                onEnded={handleAudioEnded}
                className="hidden"
            />

            <div className="max-w-4xl mx-auto">
                {/* ヘッダー */}
                <div className="flex items-center justify-between mb-6">
                    <h1 className="text-xl md:text-2xl font-bold flex items-center gap-2">
                        <FileAudio className="w-6 h-6 text-blue-400" />
                        録音データ管理
                    </h1>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={() => void fetchFiles(token).catch(() => undefined)}
                            disabled={loading}
                            className="p-2 bg-gray-800 rounded-lg hover:bg-gray-700 transition-colors disabled:opacity-50"
                            title="再読み込み"
                        >
                            <RefreshCw className={`w-5 h-5 ${loading ? "animate-spin" : ""}`} />
                        </button>
                        <button
                            onClick={handleLogout}
                            className="p-2 bg-gray-800 rounded-lg hover:bg-gray-700 transition-colors"
                            title="ログアウト"
                        >
                            <LogOut className="w-5 h-5" />
                        </button>
                    </div>
                </div>

                {/* エラー表示 */}
                {error && (
                    <div className="bg-red-900/30 border border-red-700 rounded-lg p-3 text-red-300 text-sm mb-4 flex items-center gap-2">
                        <AlertCircle className="w-4 h-4" />
                        {error}
                    </div>
                )}

                {/* ツールバー */}
                {files.length > 0 && (
                    <div className="flex items-center gap-4 mb-4 pb-4 border-b border-gray-800">
                        <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">
                            <input
                                type="checkbox"
                                checked={selectedFiles.size === files.length && files.length > 0}
                                onChange={toggleSelectAll}
                                className="w-4 h-4 rounded bg-gray-800 border-gray-600"
                            />
                            全選択
                        </label>
                        {selectedFiles.size > 0 && (
                            <button
                                onClick={deleteSelected}
                                className="px-3 py-1 bg-red-600 rounded text-sm hover:bg-red-700 transition-colors flex items-center gap-1"
                            >
                                <Trash2 className="w-4 h-4" />
                                {selectedFiles.size}件削除
                            </button>
                        )}
                        <span className="text-sm text-gray-500 ml-auto">
                            {files.length}件のファイル
                        </span>
                    </div>
                )}

                {/* ファイル一覧 */}
                {loading ? (
                    <div className="text-center py-12 text-gray-400">
                        <RefreshCw className="w-8 h-8 mx-auto animate-spin mb-2" />
                        読み込み中...
                    </div>
                ) : files.length === 0 ? (
                    <div className="text-center py-12 text-gray-500">
                        録音データがありません
                    </div>
                ) : (
                    <div className="space-y-2">
                        {files.map((file) => (
                            <div
                                key={file.name}
                                className={`bg-gray-900 border rounded-lg p-4 flex items-center gap-4 transition-colors ${selectedFiles.has(file.name) ? "border-blue-500 bg-blue-950/20" : "border-gray-800"
                                    }`}
                            >
                                <input
                                    type="checkbox"
                                    checked={selectedFiles.has(file.name)}
                                    onChange={() => toggleSelect(file.name)}
                                    className="w-4 h-4 rounded bg-gray-800 border-gray-600"
                                />

                                <div className="flex-1 min-w-0">
                                    <p className="font-medium truncate">{file.name}</p>
                                    <p className="text-sm text-gray-500">
                                        {formatSize(file.size)} · {formatDate(file.uploaded)}
                                    </p>
                                </div>

                                <div className="flex items-center gap-2">
                                    {/* 再生/停止ボタン */}
                                    <button
                                        onClick={() => playPreview(file.name)}
                                        className={`p-2 rounded-lg transition-colors ${playingFile === file.name
                                                ? "bg-green-600 hover:bg-green-700"
                                                : "bg-gray-700 hover:bg-gray-600"
                                            }`}
                                        title={playingFile === file.name ? "停止" : "再生"}
                                    >
                                        {playingFile === file.name ? (
                                            <Square className="w-4 h-4" />
                                        ) : (
                                            <Play className="w-4 h-4" />
                                        )}
                                    </button>
                                    <button
                                        onClick={() => downloadFile(file.name)}
                                        className="p-2 bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
                                        title="ダウンロード"
                                    >
                                        <Download className="w-4 h-4" />
                                    </button>
                                    <button
                                        onClick={() => deleteFile(file.name)}
                                        className="p-2 bg-red-600 rounded-lg hover:bg-red-700 transition-colors"
                                        title="削除"
                                    >
                                        <Trash2 className="w-4 h-4" />
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </main>
    );
}
