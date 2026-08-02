"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/utils/cn";

interface GlowCountdownProps {
    onComplete: () => void;
    duration?: number;
}

export function GlowCountdown({ onComplete, duration = 3 }: GlowCountdownProps) {
    const [count, setCount] = useState(duration);
    // onComplete の参照が変わっても録音を二重に開始しないようにする
    const firedRef = useRef(false);

    useEffect(() => {
        if (count <= 0) {
            if (!firedRef.current) {
                firedRef.current = true;
                onComplete();
            }
            return;
        }

        const timer = setTimeout(() => {
            setCount((prev) => prev - 1);
        }, 1000);

        return () => clearTimeout(timer);
    }, [count, onComplete]);

    if (count <= 0) return null;

    return (
        <div className="flex flex-col items-center justify-center p-8 bg-black/80 rounded-2xl backdrop-blur-md">
            <div className="text-white text-lg mb-4 font-light tracking-widest opacity-80">
                RECORDING STARTS IN
            </div>
            <div
                key={count} // keyが変わるたびにアニメーション再始動
                className={cn(
                    "text-9xl font-bold text-transparent bg-clip-text bg-gradient-to-br from-cyan-400 to-blue-600",
                    "animate-glow drop-shadow-[0_0_15px_rgba(34,211,238,0.8)]"
                )}
            >
                {count}
            </div>
        </div>
    );
}
