import { useState, useEffect, useRef, useCallback } from 'react';

interface TypewriterConfig {
  /** Whether the animation is enabled */
  enabled: boolean;
  /** Characters to reveal per animation frame (default: 25) */
  baseCharsPerFrame?: number;
  /** Maximum animation duration in ms (default: 3000) */
  maxDurationMs?: number;
  /** Character index to start animating from (for partial updates) */
  startFrom?: number;
}

interface TypewriterResult {
  /** Content to display (partial during animation, full when complete) */
  displayedContent: string;
  /** Whether animation is currently running */
  isAnimating: boolean;
  /** Progress from 0 to 1 */
  progress: number;
  /** Skip to end of animation immediately */
  skipToEnd: () => void;
}

const DEFAULT_CHARS_PER_FRAME = 25;
const DEFAULT_MAX_DURATION_MS = 3000;
const FRAME_DURATION_MS = 16; // ~60fps

/**
 * Hook that provides typewriter animation effect for text content.
 * Animates from startFrom index to full content length.
 */
export function useTypewriterAnimation(
  targetContent: string,
  config: TypewriterConfig
): TypewriterResult {
  const {
    enabled,
    baseCharsPerFrame = DEFAULT_CHARS_PER_FRAME,
    maxDurationMs = DEFAULT_MAX_DURATION_MS,
    startFrom = 0,
  } = config;

  const [displayedContent, setDisplayedContent] = useState(targetContent);
  const [isAnimating, setIsAnimating] = useState(false);
  const [progress, setProgress] = useState(1);

  const frameIdRef = useRef<number | null>(null);
  const currentIndexRef = useRef(startFrom);

  // Calculate chars per frame based on content length to cap duration
  const calculateCharsPerFrame = useCallback((contentLength: number): number => {
    const charsToAnimate = contentLength - startFrom;
    if (charsToAnimate <= 0) return baseCharsPerFrame;

    const framesNeeded = maxDurationMs / FRAME_DURATION_MS;
    const dynamicCharsPerFrame = Math.ceil(charsToAnimate / framesNeeded);

    return Math.max(baseCharsPerFrame, dynamicCharsPerFrame);
  }, [baseCharsPerFrame, maxDurationMs, startFrom]);

  const showFullContent = useCallback(() => {
    setDisplayedContent(targetContent);
    setIsAnimating(false);
    setProgress(1);
  }, [targetContent]);

  const skipToEnd = useCallback(() => {
    if (frameIdRef.current) {
      cancelAnimationFrame(frameIdRef.current);
      frameIdRef.current = null;
    }
    showFullContent();
    currentIndexRef.current = targetContent.length;
  }, [targetContent, showFullContent]);

  useEffect(() => {
    // If disabled or no content, show full content immediately
    if (!enabled || !targetContent) {
      showFullContent();
      return;
    }

    // If starting from beginning with no new content, no animation needed
    const charsToAnimate = targetContent.length - startFrom;
    if (charsToAnimate <= 0) {
      showFullContent();
      return;
    }

    // Start animation
    const charsPerFrame = calculateCharsPerFrame(targetContent.length);
    currentIndexRef.current = startFrom;
    setIsAnimating(true);
    setProgress(0);

    // Show initial content up to startFrom
    setDisplayedContent(targetContent.slice(0, startFrom));

    const animate = () => {
      currentIndexRef.current += charsPerFrame;

      if (currentIndexRef.current >= targetContent.length) {
        // Animation complete
        showFullContent();
        frameIdRef.current = null;
        return;
      }

      // Update displayed content
      setDisplayedContent(targetContent.slice(0, currentIndexRef.current));
      setProgress((currentIndexRef.current - startFrom) / charsToAnimate);

      // Schedule next frame
      frameIdRef.current = requestAnimationFrame(animate);
    };

    // Start animation on next frame
    frameIdRef.current = requestAnimationFrame(animate);

    // Cleanup on unmount or content change
    return () => {
      if (frameIdRef.current) {
        cancelAnimationFrame(frameIdRef.current);
        frameIdRef.current = null;
      }
    };
  }, [targetContent, enabled, startFrom, calculateCharsPerFrame, showFullContent]);

  return {
    displayedContent,
    isAnimating,
    progress,
    skipToEnd,
  };
}
