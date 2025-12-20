export interface AudioRecorderResult {
  blob: Blob;
  duration: number;
}

export class AudioRecorder {
  private mediaRecorder: MediaRecorder | null = null;
  private mediaStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private chunks: Blob[] = [];
  private startTime = 0;

  async start(): Promise<AnalyserNode> {
    this.chunks = [];
    this.startTime = Date.now();

    // マイク許可を取得
    this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });

    // ビジュアライザー用のAnalyserNode
    this.audioContext = new AudioContext();
    const source = this.audioContext.createMediaStreamSource(this.mediaStream);
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 2048;
    source.connect(this.analyser);

    // MediaRecorderで録音（iOSではwebmが使えないのでmp4やm4aを試す）
    let mimeType = 'audio/webm';
    if (typeof MediaRecorder !== 'undefined') {
      if (MediaRecorder.isTypeSupported('audio/webm')) {
        mimeType = 'audio/webm';
      } else if (MediaRecorder.isTypeSupported('audio/mp4')) {
        mimeType = 'audio/mp4';
      } else if (MediaRecorder.isTypeSupported('audio/aac')) {
        mimeType = 'audio/aac';
      } else if (MediaRecorder.isTypeSupported('audio/ogg')) {
        mimeType = 'audio/ogg';
      } else {
        // デフォルト（iOSの場合は何も指定しない方が良い場合がある）
        mimeType = '';
      }
    }

    const options = mimeType ? { mimeType } : undefined;
    this.mediaRecorder = new MediaRecorder(this.mediaStream, options);

    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        this.chunks.push(e.data);
      }
    };

    this.mediaRecorder.start();

    return this.analyser;
  }

  async stop(): Promise<AudioRecorderResult> {
    return new Promise((resolve, reject) => {
      if (!this.mediaRecorder) {
        reject(new Error('MediaRecorder not initialized'));
        return;
      }

      this.mediaRecorder.onstop = () => {
        const duration = (Date.now() - this.startTime) / 1000;
        const blob = new Blob(this.chunks, { type: this.mediaRecorder?.mimeType || 'audio/webm' });

        // クリーンアップ
        this.mediaStream?.getTracks().forEach((track) => track.stop());
        if (this.audioContext && this.audioContext.state !== 'closed') {
          this.audioContext.close();
        }

        resolve({ blob, duration });
      };

      this.mediaRecorder.onerror = (e) => {
        reject(new Error('録音エラー: ' + e));
      };

      this.mediaRecorder.stop();
    });
  }
}
