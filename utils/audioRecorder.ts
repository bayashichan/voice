export interface AudioRecorderResult {
  blob: Blob;
  duration: number;
}

export class AudioRecorder {
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private leftChannelData: Float32Array[] = [];
  private recordingLength = 0;
  private sampleRate = 44100;
  private analyser: AnalyserNode | null = null;

  async start(): Promise<AnalyserNode> {
    this.leftChannelData = [];
    this.recordingLength = 0;

    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 44100,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });

    this.audioContext = new AudioContext({ sampleRate: 44100 });
    this.sampleRate = this.audioContext.sampleRate;

    await this.audioContext.audioWorklet.addModule('/audio-worklet-processor.js');

    this.source = this.audioContext.createMediaStreamSource(this.mediaStream);

    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 2048;
    this.source.connect(this.analyser);

    this.workletNode = new AudioWorkletNode(this.audioContext, 'recording-processor');
    this.workletNode.port.onmessage = (e: MessageEvent<Float32Array>) => {
      this.leftChannelData.push(e.data);
      this.recordingLength += e.data.length;
    };
    this.source.connect(this.workletNode);

    return this.analyser;
  }

  async stop(): Promise<AudioRecorderResult> {
    this.workletNode?.port.close();
    this.workletNode?.disconnect();
    this.analyser?.disconnect();
    this.source?.disconnect();
    this.mediaStream?.getTracks().forEach((track) => track.stop());
    if (this.audioContext && this.audioContext.state !== 'closed') {
      await this.audioContext.close();
    }

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
      const clamped = Math.max(-1, Math.min(1, input[i]));
      output.setInt16(offset, Math.max(-32768, Math.min(32767, Math.round(clamped * 32768))), true);
    }
  }

  private writeString(view: DataView, offset: number, string: string) {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }
}
