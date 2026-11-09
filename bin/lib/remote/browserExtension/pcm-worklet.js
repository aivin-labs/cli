// AIVIN Cast — bộ thu PCM chạy ở LUỒNG ÂM THANH (AudioWorklet) cho Session Observer (25/10/2026).
// Vì sao không dùng ScriptProcessorNode: nó gọi về luồng chính của trang offscreen; luồng chính bị hãm thì Chrome bỏ khối âm thanh —
// đo 25/10/2026 chỉ ~1/3 số khối tới nơi, tiếng thu được đứt đoạn. Worklet gom khối 4096 mẫu (trộn về mono) rồi gửi qua port — tin nhắn
// xếp hàng, không mất khi luồng chính chậm.
class AivinPcmTap extends AudioWorkletProcessor {
    constructor() {
        super();
        this.buffer = new Float32Array(4096);
        this.filled = 0;
    }

    process(inputs) {
        const channels = inputs[0];
        if (channels && channels.length) {
            const frames = channels[0].length;
            for (let i = 0; i < frames; i++) {
                let sum = 0;
                for (let c = 0; c < channels.length; c++) sum += channels[c][i];
                this.buffer[this.filled++] = sum / channels.length;
                if (this.filled === this.buffer.length) {
                    this.port.postMessage(this.buffer);
                    this.buffer = new Float32Array(4096);
                    this.filled = 0;
                }
            }
        }
        return true;
    }
}

registerProcessor('aivin-pcm-tap', AivinPcmTap);
