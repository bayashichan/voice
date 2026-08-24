"use client";

import { useEffect, useRef, useState } from "react";

export interface MicMetrics {
    /** 直近フレームの最大振幅 0..1 */
    peak: number;
    /** 直近フレームの実効値 0..1。人間が感じる「声の大きさ」に近い */
    rms: number;
}

interface MicLevelMeterProps {
    /** 現在のマイク入力。マイクが無いときは null を返す */
    getMetrics: () => MicMetrics | null;
    /** 計測を回すかどうか */
    active: boolean;
}

/** これを超えたら「音を検出」表示にする */
const DETECT_ON = 0.12;
/** これを下回った状態がしばらく続いたら表示を戻す */
const DETECT_OFF = 0.06;
const DETECT_RELEASE_MS = 600;

/**
 * マイク入力のレベルメーター。
 *
 * 毎フレーム React の state を更新すると親（page.tsx）ごと再描画されて
 * 画面がちらつくため、バーの伸縮は ref 経由で DOM を直接書き換える。
 * state を触るのは「音を検出しています」の表示が切り替わる瞬間だけ。
 */
export function MicLevelMeter({ getMetrics, active }: MicLevelMeterProps) {
    const barRef = useRef<HTMLDivElement>(null);
    const peakRef = useRef<HTMLDivElement>(null);
    const [detected, setDetected] = useState(false);

    useEffect(() => {
        if (!active) return;

        let raf = 0;
        let level = 0;
        let hold = 0;
        let isDetected = false;
        let lastLoud = 0;

        const tick = () => {
            raf = requestAnimationFrame(tick);

            const metrics = getMetrics();
            // 小さな声でもバーが見えるように rms を持ち上げつつ、
            // 立ち上がりの速さは peak で拾う
            const target = metrics
                ? Math.min(1, Math.max(metrics.rms * 4.5, metrics.peak * 1.3))
                : 0;

            // VUメーターと同じく「立ち上がりは速く、戻りはゆっくり」。
            // 生の値をそのまま出すと数値が暴れてバーが点滅して見える。
            level += (target - level) * (target > level ? 0.45 : 0.08);
            hold = Math.max(hold - 0.008, level);

            if (barRef.current) {
                barRef.current.style.transform = `scaleX(${level.toFixed(3)})`;
            }
            if (peakRef.current) {
                peakRef.current.style.left = `${Math.min(100, hold * 100).toFixed(1)}%`;
                peakRef.current.style.opacity = hold > 0.02 ? "1" : "0";
            }

            const now = performance.now();
            if (level >= DETECT_ON) {
                lastLoud = now;
                if (!isDetected) {
                    isDetected = true;
                    setDetected(true);
                }
            } else if (isDetected && level < DETECT_OFF && now - lastLoud > DETECT_RELEASE_MS) {
                isDetected = false;
                setDetected(false);
            }
        };

        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [active, getMetrics]);

    return (
        <div className="w-full max-w-sm">
            <div className="relative w-full h-7 rounded-full bg-gray-800 border border-gray-700 overflow-hidden">
                <div
                    ref={barRef}
                    className="absolute inset-0 origin-left bg-gradient-to-r from-cyan-400 via-emerald-400 to-yellow-300"
                    style={{ transform: "scaleX(0)", willChange: "transform" }}
                />
                {/* 目盛り。バーの伸びが分かりやすくなる */}
                <div
                    className="absolute inset-0 pointer-events-none"
                    style={{
                        backgroundImage:
                            "repeating-linear-gradient(90deg, transparent 0 calc(10% - 2px), rgba(3,7,18,0.85) calc(10% - 2px) 10%)",
                    }}
                />
                {/* ピークホールド */}
                <div
                    ref={peakRef}
                    className="absolute top-0 bottom-0 w-[3px] bg-white/80 rounded-full transition-opacity duration-200"
                    style={{ left: "0%", opacity: 0 }}
                />
            </div>

            <p
                className={`mt-3 text-sm h-5 transition-colors ${detected ? "text-green-400" : "text-gray-500"
                    }`}
            >
                {detected ? "音を検出しています" : "声を出すとバーが伸びます"}
            </p>
        </div>
    );
}
