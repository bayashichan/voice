export interface AudioRecorderResult {
  blob: Blob;
  duration: number;
}

export class AudioRecorder {
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private leftChannelData: Float32Array[] = [];
  private recordingLength = 0;
  private sampleRate = 44100;
  private analyser: AnalyserNode | null = null;

  async start(): Promise<AnalyserNode> {
    this.leftChannelData = [];
    this.recordingLength = 0;

    // 全デバイス対応: モノラル・サンプルレート・ノイズ除去OFF を明示指定
    // iOS Safari は一部制約を無視するが、指定しておくことで品質が向上する
    const constraints: MediaStreamConstraints = {
      audio: {
        channelCount: 1,          // モノラル録音（声紋分析に最適）
        sampleRate: 44100,        // 44.1kHz（高品質）
        echoCancellation: false,  // エコーキャンセル無効（音声の歪みを防ぐ）
        noiseSuppression: false,  // ノイズ抑制無効（生の声を録る）
        autoGainControl: false,   // 自動ゲイン制御無効（音量一定で録る）
      },
    };

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch {
      // iOS等で詳細制約が拒否された場合はシンプルな設定でフォールバック
      console.warn("詳細制約でのgetUserMedia失敗。シンプル設定で再試行します。");
      this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }

    // iOS対応: サンプルレートはAudioContextの実際の値を使う
    this.audioContext = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    this.sampleRate = this.audioContext.sampleRate;

    // iOS Safari: AudioContextがsuspended状態のことがあるので必ずresumeする
    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }

    this.source = this.audioContext.createMediaStreamSource(this.mediaStream);

    // アナライザーの設定（ビジュアライザー用）
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 2048;
    this.source.connect(this.analyser);

    // 録音処理用のScriptProcessorNode
    // （AudioWorkletはiOS 14.5以降のみ対応のため、互換性を優先してScriptProcessorを使用）
    // bufferSize=4096, inputChannels=1(モノラル), outputChannels=1
    this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);

    this.processor.onaudioprocess = (e) => {
      const channel = e.inputBuffer.getChannelData(0);
      this.leftChannelData.push(new Float32Array(channel));
      this.recordingLength += channel.length;
    };

    this.source.connect(this.processor);
    // destination に接続しないと onaudioprocess が発火しないブラウザがある
    this.processor.connect(this.audioContext.destination);

    return this.analyser;
  }

  async stop(): Promise<AudioRecorderResult> {
    // プロセッサーを先に切断してデータ収集を停止
    this.processor?.disconnect();
    this.source?.disconnect();

    if (this.audioContext && this.audioContext.state !== "closed") {
      await this.audioContext.close();
    }
    // マイクを解放
    this.mediaStream?.getTracks().forEach((track) => track.stop());

    const buffer = this.mergeBuffers(this.leftChannelData, this.recordingLength);
    const wavBlob = this.encodeWAV(buffer);

    return {
      blob: wavBlob,
      duration: this.recordingLength / this.sampleRate,
    };
  }

  private mergeBuffers(channelBuffer: Float32Array[], recordingLength: number): Float32Array {
    const result = new Float32Array(recordingLength);
    let offset = 0;
    for (const buffer of channelBuffer) {
      result.set(buffer, offset);
      offset += buffer.length;
    }
    return result;
  }

  private encodeWAV(samples: Float32Array): Blob {
    const numChannels = 1; // モノラル
    const bitsPerSample = 16;
    const byteRate = this.sampleRate * numChannels * (bitsPerSample / 8);
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
    view.setUint16(22, numChannels, true);             // チャンネル数(1=モノラル)
    view.setUint32(24, this.sampleRate, true);         // サンプルレート
    view.setUint32(28, byteRate, true);               // バイトレート
    view.setUint16(32, blockAlign, true);              // ブロックアライン
    view.setUint16(34, bitsPerSample, true);           // ビット深度
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
