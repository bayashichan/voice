/**
 * VoiceScan（声分析ソフト）がそのまま解析できる WAV を作る。
 *
 * VoiceScan の録音と同じ形式にそろえる:
 *   - 22050Hz / 16bit / モノラル のリニアPCM（44バイトヘッダ）
 *   - ピークを 32767 に正規化（RecordSound.dll PcmNormalizerFilter.Normalize16）
 *   - 長さは「(録音時間×8 + 9) × 2756 サンプル」。12秒設定なら 289380 サンプル（約13.1秒）
 *     → ファイルサイズが 512000 バイトを超えるので、VoiceScan は「12秒」の解析設定
 *       （先頭 262144 サンプル = 約11.9秒を FFT）で開く
 *
 * 変換処理は VoiceScanWeb2 の js/wav-loader.js（resample / clip16 / normalize16 / buildWav）と
 * js/recorder.js（MicRecorder.toWav）をそのまま移植している。同じ入力なら同じバイト列になるので、
 * VoiceScan で直接録音した場合と同じ経路のデータになる。どちらかを変えたら両方そろえること。
 */

/** VoiceScan の録音サンプリングレート */
export const VOICESCAN_SAMPLE_RATE = 22050;

/** VoiceScan の録音時間の設定（秒）。オリジナルの既定値であり、開始のずれに最も強い */
export const VOICESCAN_RECORD_SEC = 12;

/** SoundCapture.notifySize（22050Hz・16bit・モノラルで 0.125 秒）のサンプル数 */
const CHUNK = 2756;

/** VoiceScan が 12 秒設定で解析するサンプル数（FFT サイズ） */
export const VOICESCAN_ANALYSIS_SAMPLES = 262144;

/** 録音時間の設定から WAV のサンプル数を求める（VoiceScanWeb2 MicRecorder.recordFrames） */
export function recordFrames(recSec: number): number {
  return (Math.round(recSec * 8) + 9) * CHUNK;
}

/** 出力 WAV のサンプル数（12秒設定 = 289380） */
export const VOICESCAN_FRAMES = recordFrames(VOICESCAN_RECORD_SEC);

/**
 * デバイスのサンプリングレートで何サンプル取り込めばよいか。
 * 変換（窓付き sinc）の端の影響が出ないよう 0.05 秒多く取り込み、変換後に切り詰める。
 */
export function captureSamplesFor(deviceRate: number): number {
  return Math.ceil((VOICESCAN_FRAMES / VOICESCAN_SAMPLE_RATE + 0.05) * deviceRate);
}

/**
 * これだけ取り込めていれば VoiceScan の解析範囲（先頭 262144 サンプル）がすべて実音声になる。
 * 足りない分は無音で埋まり、解析結果が変わってしまう。
 */
export function minCaptureSamplesFor(deviceRate: number): number {
  return Math.ceil((VOICESCAN_ANALYSIS_SAMPLES / VOICESCAN_SAMPLE_RATE + 0.05) * deviceRate);
}

function sinc(x: number): number {
  if (x === 0.0) return 1.0;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

function blackman(x: number, lobes: number): number {
  const t = x / lobes;
  if (t <= -1.0 || t >= 1.0) return 0.0;
  const a = Math.PI * (t + 1.0);
  return 0.42 - 0.5 * Math.cos(a) + 0.08 * Math.cos(2.0 * a);
}

function gcd(a: number, b: number): number {
  while (b) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

interface PhaseCoef {
  f0: number;
  coef: Float64Array;
  w: number;
}

/**
 * 窓関数付き sinc 補間リサンプリング（Windows 改修版 WavLoader.Resample と同一式）。
 * 位相が周期的に繰り返すため係数を位相ごとにキャッシュして高速化する。
 */
export function resample(src: Float64Array, srcRate: number, dstRate: number): Float64Array {
  if (srcRate === dstRate) return src;
  const ratio = dstRate / srcRate;
  const dstLength = Math.trunc(src.length * ratio);
  if (dstLength < 1) throw new Error("音声が短すぎて変換できません。");
  const dst = new Float64Array(dstLength);
  const scale = Math.min(1.0, ratio);
  const LOBES = 24;
  const halfWidth = LOBES / scale;
  const g = gcd(srcRate, dstRate);
  const P = dstRate / g;
  const S = srcRate / g;
  const useCache = P <= 4096;
  const cache: (PhaseCoef | undefined)[] | null = useCache ? new Array(P) : null;
  const last0 = src.length - 1;
  for (let i = 0; i < dstLength; i++) {
    const center = i / ratio;
    let first = Math.ceil(center - halfWidth);
    let last = Math.floor(center + halfWidth);
    const edge = first < 0 || last > last0;
    let sum = 0.0;
    let weight = 0.0;
    if (cache && !edge) {
      const p = i % P;
      const q = (i - p) / P;
      let e = cache[p];
      if (!e) {
        const cp = p / ratio;
        const f0 = Math.ceil(cp - halfWidth);
        const l0 = Math.floor(cp + halfWidth);
        const coef = new Float64Array(l0 - f0 + 1);
        let w = 0.0;
        for (let n = f0; n <= l0; n++) {
          const x = (n - cp) * scale;
          const c = sinc(x) * blackman(x, LOBES);
          coef[n - f0] = c;
          w += c;
        }
        e = cache[p] = { f0, coef, w };
      }
      const base = q * S + e.f0;
      const coef = e.coef;
      for (let t = 0; t < coef.length; t++) sum += src[base + t] * coef[t];
      weight = e.w;
    } else {
      if (first < 0) first = 0;
      if (last > last0) last = last0;
      for (let n = first; n <= last; n++) {
        const x = (n - center) * scale;
        const c = sinc(x) * blackman(x, LOBES);
        sum += src[n] * c;
        weight += c;
      }
    }
    dst[i] = weight !== 0.0 ? sum / weight : 0.0;
  }
  return dst;
}

/** 16bit へ丸める（MidpointRounding.AwayFromZero） */
function clip16(v: number): number {
  if (v >= 32767.0) return 32767;
  if (v <= -32768.0) return -32768;
  return v < 0 ? -Math.round(-v) : Math.round(v);
}

/** PcmNormalizerFilter.Normalize16: ピークを 32767 に揃える（C# int 除算 = 0 方向切り捨て） */
function normalize16(pcm: Int16Array): Int16Array {
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i];
    if (v > peak || -v > peak) peak = v < 0 ? -v : v;
  }
  if (peak === 0) return pcm;
  const out = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = Math.trunc((32767 * pcm[i]) / peak);
  return out;
}

/** 16bit モノラル PCM から 44 バイトヘッダの WAV を作る */
function buildWav(pcm: Int16Array, sampleRate: number): ArrayBuffer {
  const n = pcm.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(buf);
  const w4 = (o: number, s: string) => {
    for (let i = 0; i < 4; i++) dv.setUint8(o + i, s.charCodeAt(i));
  };
  w4(0, "RIFF");
  dv.setUint32(4, 36 + n * 2, true);
  w4(8, "WAVE");
  w4(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  w4(36, "data");
  dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) dv.setInt16(44 + 2 * i, pcm[i], true);
  return buf;
}

/**
 * デバイスレートの float 波形 → 22050Hz/16bit → VOICESCAN_FRAMES に切り詰め → Normalize16 → WAV。
 * 取り込みが足りない場合、末尾は無音で埋まる（VoiceScanWeb2 と同じ）。
 */
export function toVoiceScanWav(samples: Float32Array, deviceRate: number): ArrayBuffer {
  const src = Float64Array.from(samples);
  const res = resample(src, deviceRate, VOICESCAN_SAMPLE_RATE);
  const n = VOICESCAN_FRAMES;
  const pcm = new Int16Array(n);
  const m = Math.min(n, res.length);
  for (let i = 0; i < m; i++) pcm[i] = clip16(res[i] * 32767.0);
  return buildWav(normalize16(pcm), VOICESCAN_SAMPLE_RATE);
}
