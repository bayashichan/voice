export interface PreparedRecorder {
  analyser: AnalyserNode;
  sampleRate: number;
  /** 実際に使われたキャプチャ方式（不具合報告時の手がかり） */
  engine: "worklet" | "scriptprocessor";
}

export interface AudioRecorderResult {
  blob: Blob;
  /** 実際に収録できた秒数（壁時計ではなくサンプル数から算出） */
  duration: number;
  /** 収録区間の最大振幅 0..1。無音判定に使う */
  peak: number;
  sampleCount: number;
  /** 収録中にAudioContextが中断（着信・バックグラウンド等）されたか */
  interrupted: boolean;
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
 * 録音エンジン。
 *
 * iOS Safari 対策として、AudioContext の生成と resume は必ず
 * ユーザー操作（タップ）のハンドラ内で同期的に始まる prepare() で行う。
 * カウントダウンを挟んでから beginCapture() で蓄積を開始するため、
 * getUserMedia は 1 回しか呼ばれず、マイクの取り直しも発生しない。
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

    const ctx = new Ctor();
    this.audioContext = ctx;
    this.sampleRate = ctx.sampleRate;
    // --- ここまで同期 ---

    // ユーザー操作の権限が生きているうちに resume する
    if (ctx.state !== "running") {
      try {
        await ctx.resume();
      } catch {
        // resume に失敗しても getUserMedia 後に再試行する
      }
    }

    ctx.onstatechange = () => {
      // iOS では着信やバックグラウンド移行で "interrupted" / "suspended" になる
      if (this.capturing && ctx.state !== "running") {
        this.interrupted = true;
      }
    };

    this.mediaStream = await this.acquireStream();

    // resume が保留になっていた場合に備えてもう一度確認する
    if (ctx.state !== "running") {
      try {
        await ctx.resume();
      } catch {
        // ここで失敗しても beginCapture 側で再度 resume を試みる
      }
    }

    this.source = ctx.createMediaStreamSource(this.mediaStream);

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.levelBuffer = new Uint8Array(new ArrayBuffer(this.analyser.fftSize));
    this.source.connect(this.analyser);

    // 出力は必ずゲイン0を経由させる。ノードは pull され続けるが、
    // マイク音がスピーカーへ回り込む（ハウリング）ことはない。
    this.silentGain = ctx.createGain();
    this.silentGain.gain.value = 0;
    this.silentGain.connect(ctx.destination);

    const engine = await this.attachCaptureNode(ctx);

    this.prepared = true;
    this.sampleRate = ctx.sampleRate;

    return { analyser: this.analyser, sampleRate: this.sampleRate, engine };
  }

  /**
   * 蓄積を開始する。新たな権限要求は発生しないのでカウントダウン後に呼んでよい。
   * targetDurationSec に達したら onTargetReached が一度だけ呼ばれる。
   */
  beginCapture(targetDurationSec?: number, onTargetReached?: () => void): void {
    if (!this.prepared) {
      throw new Error("prepare() が完了していません");
    }

    this.chunks = [];
    this.recordingLength = 0;
    this.interrupted = false;
    this.targetFired = false;
    this.onTargetReached = onTargetReached ?? null;
    this.targetSamples =
      targetDurationSec && targetDurationSec > 0
        ? Math.ceil(targetDurationSec * this.sampleRate)
        : Number.POSITIVE_INFINITY;

    const ctx = this.audioContext;
    if (ctx && ctx.state !== "running") {
      // 収録直前の最後の砦。ここで復帰しなかった場合は onstatechange と
      // 収録後の長さ・無音チェックが取りこぼしを検知する。
      void ctx.resume().catch(() => undefined);
    }

    this.capturing = true;
    this.workletNode?.port.postMessage({ type: "start" });
  }

  /** 収録を止めて WAV を組み立てる。マイクと AudioContext も解放する。 */
  async stop(): Promise<AudioRecorderResult> {
    this.capturing = false;
    this.workletNode?.port.postMessage({ type: "stop" });

    const samples = this.mergeBuffers(this.chunks, this.recordingLength);
    const sampleRate = this.sampleRate;
    const interrupted = this.interrupted;

    await this.teardown();

    const peak = this.calcPeak(samples);
    const blob = this.encodeWAV(samples, sampleRate);

    return {
      blob,
      duration: samples.length / sampleRate,
      peak,
      sampleCount: samples.length,
      interrupted,
    };
  }

  /** 収録結果を取らずに片付ける（中断・やり直し時） */
  async dispose(): Promise<void> {
    this.capturing = false;
    this.chunks = [];
    this.recordingLength = 0;
    await this.teardown();
  }

  /** マイク入力の現在レベル 0..1。マイクテストのメーター用。 */
  getInputLevel(): number {
    if (!this.analyser || !this.levelBuffer) return 0;
    this.analyser.getByteTimeDomainData(this.levelBuffer);
    let peak = 0;
    for (let i = 0; i < this.levelBuffer.length; i++) {
      const v = Math.abs(this.levelBuffer[i] - 128) / 128;
      if (v > peak) peak = v;
    }
    return peak;
  }

  isPrepared(): boolean {
    return this.prepared;
  }

  // ---------------------------------------------------------------- internals

  private async acquireStream(): Promise<MediaStream> {
    // すべて ideal 指定にする。exact 相当の指定だと 48kHz 固定の端末で
    // OverconstrainedError になり、フォールバックで音声処理OFFの指定ごと失われていた。
    const constraints: MediaStreamConstraints = {
      audio: {
        channelCount: { ideal: 1 },
        sampleRate: { ideal: 48000 },
        echoCancellation: { ideal: false },
        noiseSuppression: { ideal: false },
        autoGainControl: { ideal: false },
      },
    };

    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      // 権限拒否・マイク不在などはそのまま呼び出し元へ返す（誤ったフォールバックをしない）
      const name = e instanceof Error ? e.name : "";
      if (name !== "OverconstrainedError" && name !== "ConstraintNotSatisfiedError") {
        throw e;
      }
      console.warn("詳細制約でのgetUserMedia失敗。シンプル設定で再試行します。", e);
      return await navigator.mediaDevices.getUserMedia({ audio: true });
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

  private calcPeak(samples: Float32Array): number {
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
      const v = Math.abs(samples[i]);
      if (v > peak) peak = v;
    }
    return peak;
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

  private encodeWAV(samples: Float32Array, sampleRate: number): Blob {
    const numChannels = 1; // モノラル
    const bitsPerSample = 16;
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
    const blockAlign = numChannels * (bitsPerSample / 8);
    const dataSize = samples.length * (bitsPerSample / 8);

    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    // WAVヘッダー
    this.writeString(view, 0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);           // ファイルサイズ - 8
    this.writeString(view, 8, "WAVE");
    this.writeString(view, 12, "fmt ");
    view.setUint32(16, 16, true);                     // fmtチャンクサイズ
    view.setUint16(20, 1, true);                      // PCMフォーマット
    view.setUint16(22, numChannels, true);            // チャンネル数(1=モノラル)
    view.setUint32(24, sampleRate, true);             // サンプルレート
    view.setUint32(28, byteRate, true);               // バイトレート
    view.setUint16(32, blockAlign, true);             // ブロックアライン
    view.setUint16(34, bitsPerSample, true);          // ビット深度
    this.writeString(view, 36, "data");
    view.setUint32(40, dataSize, true);               // データサイズ

    this.floatTo16BitPCM(view, 44, samples);

    return new Blob([view], { type: "audio/wav" });
  }

  private floatTo16BitPCM(output: DataView, offset: number, input: Float32Array) {
    for (let i = 0; i < input.length; i++, offset += 2) {
      const s = Math.max(-1, Math.min(1, input[i]));
      output.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
  }

  private writeString(view: DataView, offset: number, string: string) {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }
}
