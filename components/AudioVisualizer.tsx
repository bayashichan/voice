"use client";

import { useEffect, useRef } from "react";

interface AudioVisualizerProps {
    analyser: AnalyserNode;
    isRecording: boolean;
}

export function AudioVisualizer({ analyser, isRecording }: AudioVisualizerProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const animationRef = useRef<number>(0); // 初期値を0に修正

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !analyser) return;

        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);

        const draw = () => {
            if (!isRecording) return;

            animationRef.current = requestAnimationFrame(draw);

            analyser.getByteFrequencyData(dataArray);

            ctx.fillStyle = "rgba(10, 10, 10, 0.2)"; // 残像効果のためのフェードアウト
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            const barWidth = (canvas.width / bufferLength) * 2.5;
            let barHeight;
            let x = 0;

            for (let i = 0; i < bufferLength; i++) {
                barHeight = dataArray[i];

                // グラデーションの作成（Cyan -> Blue）
                const gradient = ctx.createLinearGradient(0, canvas.height, 0, 0);
                gradient.addColorStop(0, "rgba(6,182,212,0.8)"); // cyan-500
                gradient.addColorStop(1, "rgba(59,130,246,0.8)"); // blue-500

                ctx.fillStyle = gradient;

                // バーの描画（上下対称にして波形っぽくする）
                const normalizedHeight = (barHeight / 255) * (canvas.height / 2);

                // 中心から上下に描画
                const centerY = canvas.height / 2;
                ctx.fillRect(x, centerY - normalizedHeight, barWidth, normalizedHeight * 2);

                x += barWidth + 1;
            }
        };

        if (isRecording) {
            draw();
        } else {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            cancelAnimationFrame(animationRef.current);
        }

        return () => {
            cancelAnimationFrame(animationRef.current);
        };
    }, [analyser, isRecording]);

    return (
        <div className="w-full h-40 flex items-center justify-center bg-gray-900/50 rounded-xl overflow-hidden border border-gray-800 shadow-inner">
            <canvas
                ref={canvasRef}
                width={600}
                height={160}
                className="w-full h-full"
            />
        </div>
    );
}
