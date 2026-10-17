import React from 'react';

interface Props {
  className?: string;
  size?: number;
}

export const BlackHoleLogo: React.FC<Props> = ({ className = 'w-10 h-10', size = 100 }) => {
  return (
    <svg
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      width={size}
      height={size}
    >
      <defs>
        <radialGradient id="spaceGlowLogo" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#8b5cf6" stopOpacity="0.7" />
          <stop offset="50%" stopColor="#06b6d4" stopOpacity="0.3" />
          <stop offset="100%" stopColor="#030712" stopOpacity="0" />
        </radialGradient>

        <linearGradient id="accretionGradLogo" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#06b6d4" />
          <stop offset="40%" stopColor="#8b5cf6" />
          <stop offset="70%" stopColor="#ec4899" />
          <stop offset="100%" stopColor="#3b82f6" />
        </linearGradient>

        <linearGradient id="photonRingLogo" x1="0%" y1="100%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#f43f5e" />
          <stop offset="50%" stopColor="#c084fc" />
          <stop offset="100%" stopColor="#38bdf8" />
        </linearGradient>

        <radialGradient id="eventHorizonLogo" cx="50%" cy="50%" r="50%">
          <stop offset="70%" stopColor="#020617" />
          <stop offset="95%" stopColor="#090d16" />
          <stop offset="100%" stopColor="#3b0764" stopOpacity="0.8" />
        </radialGradient>

        <filter id="glowLogo" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feComposite in="SourceGraphic" in2="blur" operator="over" />
        </filter>
      </defs>

      {/* Ambient Glow */}
      <circle cx="50" cy="50" r="48" fill="url(#spaceGlowLogo)" />

      {/* Accretion Disk (Back) */}
      <ellipse
        cx="50"
        cy="50"
        rx="42"
        ry="14"
        transform="rotate(-28 50 50)"
        stroke="url(#accretionGradLogo)"
        strokeWidth="5"
        strokeDasharray="140 40"
        strokeLinecap="round"
        opacity="0.9"
        filter="url(#glowLogo)"
      />
      <ellipse
        cx="50"
        cy="50"
        rx="36"
        ry="10"
        transform="rotate(-28 50 50)"
        stroke="#38bdf8"
        strokeWidth="2"
        opacity="0.8"
      />

      {/* Relativistic Lensing Arcs */}
      <path
        d="M 22 40 C 32 20, 68 20, 78 40"
        stroke="url(#photonRingLogo)"
        strokeWidth="3.5"
        strokeLinecap="round"
        opacity="0.9"
        filter="url(#glowLogo)"
      />
      <path
        d="M 28 62 C 38 78, 62 78, 72 62"
        stroke="url(#photonRingLogo)"
        strokeWidth="2.5"
        strokeLinecap="round"
        opacity="0.7"
      />

      {/* Event Horizon */}
      <circle cx="50" cy="50" r="22" fill="url(#eventHorizonLogo)" />
      <circle cx="50" cy="50" r="22" stroke="url(#photonRingLogo)" strokeWidth="1.8" opacity="0.9" />

      {/* Foreground Accretion Stream */}
      <path
        d="M 18 56 C 26 66, 68 58, 82 44"
        stroke="url(#accretionGradLogo)"
        strokeWidth="6"
        strokeLinecap="round"
        filter="url(#glowLogo)"
      />
      <path
        d="M 26 55 C 34 62, 60 56, 76 46"
        stroke="#ffffff"
        strokeWidth="1.5"
        strokeLinecap="round"
        opacity="0.8"
      />

      {/* Singularity Core */}
      <circle cx="50" cy="50" r="16" fill="#000000" />
    </svg>
  );
};
