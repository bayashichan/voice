import {
  captureSamplesFor,
  minCaptureSamplesFor,
  toVoiceScanWav,
} from "./voicescanFormat";

export interface MicMetrics {
  /** 直近フレームの最大振幅 0..1 */
  peak: number;
  /** 直近フレームの実効値 0..1 */
  rms: number;
}

export interface PreparedRecorder {
  analyser: AnalyserNode;
  sampleRate: number;
  /** 実際に使われたキャプチャ方式（不具合報告時の手がかり） */
  engine: "worklet" | "scriptprocessor";
}

export interface AudioRecorderResult {
  /** VoiceScan がそのまま解析できる WAV（22050Hz/16bit/モノラル・正規化済み） */
  blob: Blob;
  /** 実際に収録できた秒数（壁時計ではなくサンプル数から算出） */
  duration: number;
  /** 収録区間の最大振幅 0..1。無音判定に使う */
  peak: number;
  /** フルスケール付近（音割れ）のサンプルの割合 0..1 */
  clipRatio: number;
  /** 声と背景雑音の差の推定値（dB）。30msごとの音量の上位5%と下位10%の差 */
  snrDb: number;
  sampleCount: number;
  /** VoiceScan の解析範囲（先頭約11.9秒）をすべて実音声で埋められたか */
  enoughForAnalysis: boolean;
  /** 収録中にAudioContextが中断（着信・バックグラウンド等）されたか */
  interrupted: boolean;
  /** 取り込み時のサンプリングレート（変換前） */
  captureRate: number;
}

export interface CaptureProgress {
  /** 0..1 */
  ratio: number;
  /** 最後に音声データが届いた時刻（performance.now()）。まだ届いていなければ 0 */
  lastDataAt: number;
}

/** マイクに実際に適用された設定（ブラウザが制約を無視することがあるので記録する） */
export interface TrackInfo {
  sampleRate: number | null;
  echoCancellation: boolean | null;
  noiseSuppression: boolean | null;
  autoGainControl: boolean | null;
}

type AudioContextCtor = typeof AudioContext;

function getAudioContextCtor(): AudioContextCtor | null {
  if (typeof window === "undefined") return null;
  return (
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext ||
    null
  );
}

/**
 * すべて ideal 指定にする。exact 相当の指定だと 48kHz 固定の端末で
 * OverconstrainedError になり、フォールバックで音声処理OFFの指定ごと失われていた。
 */
const PRIMARY_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    channelCount: { ideal: 1 },
    sampleRate: { ideal: 48000 },
    echoCancellation: { ideal: false },
    noiseSuppression: { ideal: false },
    autoGainControl: { ideal: false },
  },
};

/**
 * 録音エンジン。
 *
 * iOS Safari 対策として、AudioContext の生成と resume は必ず
 * ユーザー操作（タップ）のハンドラ内で同期的に始まる prepare() で行う。
 * カウントダウンを挟んでから beginCapture() で蓄積を開始するため、
 * getUserMedia は 1 回しか呼ばれず、マイクの取り直しも発生しない。
 *
 * 取り込みは端末のサンプリングレートのまま行い、stop() で VoiceScan の録音と
 * 同じ形式（22050Hz/16bit/モノラル・ピーク正規化・12秒設定の長さ）に変換する。
 */
export class AudioRecorder {
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private silentGain: GainNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private processor: ScriptProcessorNode | null = null;

  private chunks: Float32Array[] = [];
  private recordingLength = 0;
  private sampleRate = 48000;
  private capturing = false;
  private prepared = false;
  private interrupted = false;

  private targetSamples = Number.POSITIVE_INFINITY;
  private onTargetReached: (() => void) | null = null;
  private targetFired = false;
  private lastDataAt = 0;
  private trackInfo: TrackInfo | null = null;

  private levelBuffer: Uint8Array<ArrayBuffer> | null = null;

  /**
   * マイクを取得し、オーディオグラフを組み立てるところまで行う。まだ録音はしない。
   * 必ずタップ等のユーザー操作ハンドラから呼ぶこと。
   */
  async prepare(): Promise<PreparedRecorder> {
    // --- ここから最初の await までは同期実行される。iOS のユーザー操作要件を満たす要。---
    const Ctor = getAudioContextCtor();
    if (!Ctor) {
      throw new TypeError("AudioContext is not supported");
    }
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      throw new TypeError("getUserMedia is not supported");
    }

    // ★ iOS Safari ではタップと同じタスクの中で getUserMedia を呼ばないと
    //   ユーザー操作（transient activation）が切れたと見なされ、許可ダイアログを
    //   出さないまま NotAllowedError で即座に失敗する。
    //   以前はこの前に `await ctx.resume()` を挟んでいたため、
    //   すでに許可済みの端末（開発者の実機）では動くのに、
    //   初めて開いた人だけが「マイク準備 / NotAllowedError」で弾かれていた。
    //   よって getUserMedia を最初の非同期処理にする。
    const streamPromise = navigator.mediaDevices.getUserMedia(PRIMARY_CONSTRAINTS);
    // await が付くまでの間に reject されても unhandledrejection にしない
    streamPromise.catch(() => undefined);

    const ctx = new Ctor();
    this.audioContext = ctx;
    this.sampleRate = ctx.sampleRate;
    // resume も操作直後に始めるが、await して getUserMedia を待たせない
    void ctx.resume().catch(() => undefined);
    // --- ここまで同期。getUserMedia はタップと同じタスクで発行済み ---

    ctx.onstatechange = () => {
      // iOS では着信やバックグラウンド移行で "interrupted" / "suspended" になる
      if (this.capturing && ctx.state !== "running") {
        this.interrupted = true;
      }
    };

    this.mediaStream = await this.awaitStream(streamPromise);
    this.trackInfo = this.readTrackInfo(this.mediaStream);

    // resume が保留になっていた場合に備えてもう一度確認する
    if (ctx.state !== "running") {
      try {
        await ctx.resume();
      } catch {
        // ここで失敗しても beginCapture 側で再度 resume を試みる
      }
    }

    this.source = ctx.createMediaStreamSource(this.mediaStream);

    // 出力は必ずゲイン0を経由させる。ノードは pull され続けるが、
    // マイク音がスピーカーへ回り込む（ハウリング）ことはない。
    this.silentGain = ctx.createGain();
    this.silentGain.gain.value = 0;
    this.silentGain.connect(ctx.destination);

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.levelBuffer = new Uint8Array(new ArrayBuffer(this.analyser.fftSize));
    this.source.connect(this.analyser);
    // アナライザーも destination までつないでおく。出力が繋がっていないノードは
    // 実装によっては処理対象から外れ、レベルメーターが無音のままになる。
    this.analyser.connect(this.silentGain);

    const engine = await this.attachCaptureNode(ctx);

    this.prepared = true;
    this.sampleRate = ctx.sampleRate;

    return { analyser: this.analyser, sampleRate: this.sampleRate, engine };
  }

  /**
   * 蓄積を開始する。新たな権限要求は発生しないのでカウントダウン後に呼んでよい。
   * VoiceScan の 12 秒設定と同じ長さ（約13.1秒）を取り込んだら onTargetReached が一度だけ呼ばれる。
   */
  beginCapture(onTargetReached?: () => void): void {
    if (!this.prepared) {
      throw new Error("prepare() が完了していません");
    }

    this.chunks = [];
    this.recordingLength = 0;
    this.interrupted = false;
    this.targetFired = false;
    this.lastDataAt = 0;
    this.onTargetReached = onTargetReached ?? null;
    this.targetSamples = captureSamplesFor(this.sampleRate);

    const ctx = this.audioContext;
    if (ctx && ctx.state !== "running") {
      // 収録直前の最後の砦。ここで復帰しなかった場合は onstatechange と
      // 収録後の長さ・無音チェックが取りこぼしを検知する。
      void ctx.resume().catch(() => undefined);
    }

    this.capturing = true;
    this.workletNode?.port.postMessage({ type: "start" });
  }

  /** 録音の進み具合。プログレスバーと「音声が止まった」検知に使う */
  getCaptureProgress(): CaptureProgress {
    const ratio =
      Number.isFinite(this.targetSamples) && this.targetSamples > 0
        ? Math.min(1, this.recordingLength / this.targetSamples)
        : 0;
    return { ratio, lastDataAt: this.lastDataAt };
  }

  getTrackInfo(): TrackInfo | null {
    return this.trackInfo;
  }

  /** 収録を止めて VoiceScan 形式の WAV を組み立てる。マイクと AudioContext も解放する。 */
  async stop(): Promise<AudioRecorderResult> {
    this.capturing = false;
    this.workletNode?.port.postMessage({ type: "stop" });

    const samples = this.mergeBuffers(this.chunks, this.recordingLength);
    this.chunks = [];
    const sampleRate = this.sampleRate;
    const interrupted = this.interrupted;

    await this.teardown();

    const { peak, clipRatio } = this.measureLevel(samples);
    const snrDb = this.estimateSnrDb(samples, sampleRate);
    // 22050Hz への変換は低速な端末で数百ミリ秒かかる。先に「保存中」の画面を描かせる
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    const wav = toVoiceScanWav(samples, sampleRate);

    return {
      blob: new Blob([wav], { type: "audio/wav" }),
      duration: samples.length / sampleRate,
      peak,
      clipRatio,
      snrDb,
      sampleCount: samples.length,
      enoughForAnalysis: samples.length >= minCaptureSamplesFor(sampleRate),
      interrupted,
      captureRate: sampleRate,
    };
  }

  /** 収録結果を取らずに片付ける（中断・やり直し時） */
  async dispose(): Promise<void> {
    this.capturing = false;
    this.chunks = [];
    this.recordingLength = 0;
    await this.teardown();
  }

  /**
   * マイク入力の現在レベル。マイクテストのメーター用。
   * 瞬間の最大振幅（peak）と実効値（rms）を返す。rms の方が声の大きさに近い。
   */
  getInputMetrics(): MicMetrics | null {
    if (!this.analyser || !this.levelBuffer) return null;
    this.analyser.getByteTimeDomainData(this.levelBuffer);

    let peak = 0;
    let sumSquares = 0;
    for (let i = 0; i < this.levelBuffer.length; i++) {
      const v = (this.levelBuffer[i] - 128) / 128;
      const abs = Math.abs(v);
      if (abs > peak) peak = abs;
      sumSquares += v * v;
    }

    return { peak, rms: Math.sqrt(sumSquares / this.levelBuffer.length) };
  }

  isPrepared(): boolean {
    return this.prepared;
  }

  // ---------------------------------------------------------------- internals

  private async awaitStream(streamPromise: Promise<MediaStream>): Promise<MediaStream> {
    try {
      return await streamPromise;
    } catch (e) {
      // 権限拒否・マイク不在などはそのまま呼び出し元へ返す（誤ったフォールバックをしない）
      const name = e instanceof Error ? e.name : "";
      if (name !== "OverconstrainedError" && name !== "ConstraintNotSatisfiedError") {
        throw e;
      }
      console.warn("詳細制約でのgetUserMedia失敗。シンプル設定で再試行します。", e);
      // 音声処理OFFだけは保つ。ノイズ除去や自動音量がかかると周波数成分が変わり、
      // VoiceScan の解析結果がずれる
      try {
        return await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
      } catch {
        return await navigator.mediaDevices.getUserMedia({ audio: true });
      }
    }
  }

  private async attachCaptureNode(
    ctx: AudioContext
  ): Promise<"worklet" | "scriptprocessor"> {
    if (ctx.audioWorklet) {
      try {
        await ctx.audioWorklet.addModule("/recorder-worklet.js");
        const node = new AudioWorkletNode(ctx, "recorder-processor", {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
        });
        node.port.onmessage = (event: MessageEvent<Float32Array>) => {
          if (!this.capturing) return;
          this.pushChunk(event.data);
        };
        this.source!.connect(node);
        node.connect(this.silentGain!);
        this.workletNode = node;
        return "worklet";
      } catch (e) {
        console.warn("AudioWorkletの初期化に失敗。ScriptProcessorで続行します。", e);
      }
    }

    // フォールバック: 古い環境向け
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (e) => {
      if (!this.capturing) return;
      this.pushChunk(new Float32Array(e.inputBuffer.getChannelData(0)));
    };
    this.source!.connect(processor);
    processor.connect(this.silentGain!);
    this.processor = processor;
    return "scriptprocessor";
  }

  private pushChunk(chunk: Float32Array) {
    this.lastDataAt = performance.now();
    if (this.recordingLength >= this.targetSamples) return;

    this.chunks.push(chunk);
    this.recordingLength += chunk.length;

    if (!this.targetFired && this.recordingLength >= this.targetSamples) {
      this.targetFired = true;
      this.capturing = false;
      this.workletNode?.port.postMessage({ type: "stop" });
      this.onTargetReached?.();
    }
  }

  private async teardown(): Promise<void> {
    if (this.workletNode) {
      this.workletNode.port.onmessage = null;
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    if (this.processor) {
      this.processor.onaudioprocess = null;
      this.processor.disconnect();
      this.processor = null;
    }
    this.analyser?.disconnect();
    this.silentGain?.disconnect();
    this.source?.disconnect();

    this.mediaStream?.getTracks().forEach((track) => track.stop());
    this.mediaStream = null;

    if (this.audioContext) {
      this.audioContext.onstatechange = null;
      if (this.audioContext.state !== "closed") {
        try {
          await this.audioContext.close();
        } catch {
          // すでに閉じられている場合は無視
        }
      }
      this.audioContext = null;
    }

    this.analyser = null;
    this.silentGain = null;
    this.source = null;
    this.levelBuffer = null;
    this.prepared = false;
  }

  /** 最大振幅と、フルスケール付近（音割れ）のサンプルの割合 */
  private measureLevel(samples: Float32Array): { peak: number; clipRatio: number } {
    let peak = 0;
    let clipped = 0;
    for (let i = 0; i < samples.length; i++) {
      const v = Math.abs(samples[i]);
      if (v > peak) peak = v;
      if (v >= 0.99) clipped++;
    }
    return { peak, clipRatio: samples.length > 0 ? clipped / samples.length : 0 };
  }

  /**
   * 声と背景雑音の差（dB）を推定する。名前を繰り返す合間の息継ぎが雑音側になる。
   * 30ms ごとの音量（dB）の 95 パーセンタイルを声、10 パーセンタイルを雑音とみなす。
   */
  private estimateSnrDb(samples: Float32Array, sampleRate: number): number {
    const frame = Math.max(1, Math.round(sampleRate * 0.03));
    const levels: number[] = [];
    for (let i = 0; i + frame <= samples.length; i += frame) {
      let sum = 0;
      for (let j = i; j < i + frame; j++) sum += samples[j] * samples[j];
      levels.push(10 * Math.log10(sum / frame + 1e-12));
    }
    if (levels.length < 10) return 0;
    levels.sort((a, b) => a - b);
    const at = (p: number) => levels[Math.floor(p * (levels.length - 1))];
    return at(0.95) - at(0.1);
  }

  private readTrackInfo(stream: MediaStream): TrackInfo | null {
    try {
      const track = stream.getAudioTracks()[0];
      const s = track?.getSettings ? track.getSettings() : null;
      if (!s) return null;
      const flag = (v: unknown) => (typeof v === "boolean" ? v : null);
      return {
        sampleRate: typeof s.sampleRate === "number" ? s.sampleRate : null,
        echoCancellation: flag(s.echoCancellation),
        noiseSuppression: flag(s.noiseSuppression),
        autoGainControl: flag(s.autoGainControl),
      };
    } catch {
      return null;
    }
  }

  private mergeBuffers(chunks: Float32Array[], recordingLength: number): Float32Array {
    const result = new Float32Array(recordingLength);
    let offset = 0;
    for (const chunk of chunks) {
      const remaining = recordingLength - offset;
      if (remaining <= 0) break;
      if (chunk.length <= remaining) {
        result.set(chunk, offset);
        offset += chunk.length;
      } else {
        result.set(chunk.subarray(0, remaining), offset);
        offset += remaining;
      }
    }
    return result;
  }
}
