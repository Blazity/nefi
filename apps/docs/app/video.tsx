'use client';

import { useRef, useState, useEffect } from 'react';

type AspectRatio = 'square' | 'video' | 'auto' | '4/3' | '21/9';

type VideoProps = {
  src: string;
  className?: string;
  autoPlay?: boolean;
  loop?: boolean;
  muted?: boolean;
  controls?: boolean;
  poster?: string;
  aspectRatio?: AspectRatio;
};

function LoadingSpinner() {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-gray-300/20">
      <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
    </div>
  );
}

export function Video({
  src,
  className = '',
  autoPlay = false,
  loop = false,
  muted = false,
  controls = true,
  poster,
  aspectRatio = 'video',
}: VideoProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isInView, setIsInView] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setIsInView(true);
            observer.unobserve(entry.target);
          }
        });
      },
      {
        root: null,
        rootMargin: '50px',
        threshold: 0.1,
      }
    );

    if (containerRef.current) {
      observer.observe(containerRef.current);
    }

    return () => {
      if (containerRef.current) {
        observer.unobserve(containerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleLoadStart = () => {
      setIsLoading(true);
    };

    const handleCanPlay = () => {
      setIsLoading(false);
    };

    video.addEventListener('loadstart', handleLoadStart);
    video.addEventListener('canplay', handleCanPlay);

    return () => {
      video.removeEventListener('loadstart', handleLoadStart);
      video.removeEventListener('canplay', handleCanPlay);
    };
  }, []);

  return (
    <div 
      ref={containerRef}
      className={`relative w-full ${className} ${getAspectRatioClass(aspectRatio)}`}
    >
      {isLoading && <LoadingSpinner />}
      <video
        ref={videoRef}
        className={`w-full h-full rounded-lg transition-opacity duration-300 ${isLoading ? 'opacity-0' : 'opacity-100'}`}
        autoPlay={autoPlay}
        loop={loop}
        muted={muted}
        controls={controls}
        poster={poster}
        preload={isInView ? 'auto' : 'none'}
      >
        {isInView && <source src={src} type="video/mp4" />}
        Your browser does not support the video tag.
      </video>
    </div>
  );
}

function getAspectRatioClass(ratio: AspectRatio): string {
  switch (ratio) {
    case 'square':
      return 'aspect-square';
    case 'video':
      return 'aspect-video';
    case 'auto':
      return 'aspect-auto';
    case '4/3':
      return 'aspect-[4/3]';
    case '21/9':
      return 'aspect-[21/9]';
    default:
      return 'aspect-video';
  }
}
