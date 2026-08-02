/**
 * 録音用 AudioWorkletProcessor
 *
 * ScriptProcessorNode と違いオーディオ専用スレッドで動くため、
 * メインスレッドが重い端末（廉価Androidなど）でもバッファを取りこぼさない。
 *
 * process() は 128 フレームごとに呼ばれる（48kHzなら毎秒375回）。
 * そのたびに postMessage するとメインスレッドがメッセージ処理で埋まるので、
 * 4096 フレーム分ためてからまとめて送る。
 */
const CHUNK_FRAMES = 4096;

class RecorderProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.capturing = false;
        this.buffer = new Float32Array(CHUNK_FRAMES);
        this.offset = 0;

        this.port.onmessage = (event) => {
            const type = event.data && event.data.type;
            if (type === "start") {
                this.offset = 0;
                this.capturing = true;
            } else if (type === "stop") {
                this.capturing = false;
                this.flush();
            }
        };
    }

    flush() {
        if (this.offset > 0) {
            // buffer は使い回すので必ずコピーを送る
            this.port.postMessage(this.buffer.slice(0, this.offset));
            this.offset = 0;
        }
    }

    process(inputs) {
        const input = inputs[0];
        if (!input || input.length === 0) {
            // 入力が途切れてもノードは生かし続ける
            return true;
        }

        if (this.capturing) {
            const channel = input[0];
            if (channel && channel.length > 0) {
                let read = 0;
                while (read < channel.length) {
                    const n = Math.min(channel.length - read, this.buffer.length - this.offset);
                    this.buffer.set(channel.subarray(read, read + n), this.offset);
                    this.offset += n;
                    read += n;
                    if (this.offset === this.buffer.length) {
                        this.flush();
                    }
                }
            }
        }

        return true;
    }
}

registerProcessor("recorder-processor", RecorderProcessor);
