import type { ReactNode, SVGProps } from "react";

type P = { size?: number; className?: string };

function I({
  size = 18,
  className = "",
  children,
  ...p
}: P & { children: ReactNode } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      className={`ic ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...p}
    >
      {children}
    </svg>
  );
}

export const IcPlay = (p: P) => (
  <I {...p}>
    <path d="M7 4.5l12 7.5-12 7.5z" fill="currentColor" stroke="none" />
  </I>
);
export const IcStop = (p: P) => (
  <I {...p}>
    <rect x="5.5" y="5.5" width="13" height="13" rx="2" fill="currentColor" stroke="none" />
  </I>
);
export const IcRestart = (p: P) => (
  <I {...p}>
    <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" />
    <path d="M3.5 3.5v5h5" />
  </I>
);
export const IcRefresh = (p: P) => (
  <I {...p}>
    <path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1" />
    <path d="M20.5 3.5v5h-5" />
  </I>
);
export const IcPause = (p: P) => (
  <I {...p}>
    <rect x="6" y="5" width="4" height="14" rx="1" />
    <rect x="14" y="5" width="4" height="14" rx="1" />
  </I>
);
export const IcX = (p: P) => (
  <I {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </I>
);
export const IcCheck = (p: P) => (
  <I {...p}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </I>
);
export const IcAlert = (p: P) => (
  <I {...p}>
    <path d="M12 3.5l9.5 16.5h-19z" />
    <path d="M12 10v4.5M12 17.5v.01" />
  </I>
);
export const IcBan = (p: P) => (
  <I {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M6 6l12 12" />
  </I>
);
export const IcInfo = (p: P) => (
  <I {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5.5M12 7.5v.01" />
  </I>
);
export const IcSkip = (p: P) => (
  <I {...p}>
    <path d="M5 6l6 6-6 6M13 6l6 6-6 6" />
  </I>
);
export const IcLock = (p: P) => (
  <I {...p}>
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </I>
);
export const IcHalf = (p: P) => (
  <I {...p}>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" />
  </I>
);
export const IcApps = (p: P) => (
  <I {...p}>
    <path d="M12 3l9 5-9 5-9-5z" />
    <path d="M3 13l9 5 9-5" />
  </I>
);
export const IcFile = (p: P) => (
  <I {...p}>
    <path d="M6 3h9l4 4v14H6z" />
    <path d="M14.5 13.5a3 3 0 1 1-.9-2.1" />
    <path d="M14.5 10v2h-2" />
  </I>
);
export const IcChevron = (p: P) => (
  <I {...p}>
    <path d="M9 6l6 6-6 6" />
  </I>
);
export const IcPlug = (p: P) => (
  <I {...p}>
    <path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0z" />
    <path d="M12 17v4" />
  </I>
);

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <svg
      className="spinner"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        strokeOpacity=".25"
        strokeWidth="3"
        fill="none"
      />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="3"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}
