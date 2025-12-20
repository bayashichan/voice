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

    this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });

    // iOS対応: サンプルレートを指定せずにAudioContextを作成
    this.audioContext = new AudioContext();
    this.sampleRate = this.audioContext.sampleRate;

    this.source = this.audioContext.createMediaStreamSource(this.mediaStream);

    // アナライザーの設定（ビジュアライザー用）
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 2048;
    this.source.connect(this.analyser);

    // 録音処理用のノード
    this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);

    this.processor.onaudioprocess = (e) => {
      const left = e.inputBuffer.getChannelData(0);
      this.leftChannelData.push(new Float32Array(left));
      this.recordingLength += left.length;
    };

    this.source.connect(this.processor);
    this.processor.connect(this.audioContext.destination);

    return this.analyser;
  }

  async stop(): Promise<AudioRecorderResult> {
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close();
    }
    this.mediaStream?.getTracks().forEach((track) => track.stop());
    this.processor?.disconnect();
    this.source?.disconnect();

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
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);

    this.writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    this.writeString(view, 8, 'WAVE');
    this.writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, this.sampleRate, true);
    view.setUint32(28, this.sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    this.writeString(view, 36, 'data');
    view.setUint32(40, samples.length * 2, true);

    this.floatTo16BitPCM(view, 44, samples);

    return new Blob([view], { type: 'audio/wav' });
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
