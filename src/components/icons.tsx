interface IconProps {
  name: string;
  className?: string;
}

export function Icon({ name, className = "h-4 w-4" }: IconProps) {
  const paths: Record<string, React.ReactNode> = {
    grid: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
      </>
    ),
    bot: (
      <>
        <rect x="4" y="8" width="16" height="11" rx="3" />
        <path d="M12 8V4M8 4h8" />
        <circle cx="9" cy="13" r="1" fill="currentColor" stroke="none" />
        <circle cx="15" cy="13" r="1" fill="currentColor" stroke="none" />
        <path d="M9.5 16.5h5" />
      </>
    ),
    layers: (
      <>
        <path d="M12 3 3 8l9 5 9-5-9-5Z" />
        <path d="m3 13 9 5 9-5" />
      </>
    ),
    chart: (
      <>
        <path d="M4 20V10M10 20V4M16 20v-8M21 20H3" />
      </>
    ),
    target: (
      <>
        <circle cx="12" cy="12" r="9" />
        <circle cx="12" cy="12" r="5" />
        <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
      </>
    ),
    scroll: (
      <>
        <path d="M8 3h11a1 1 0 0 1 1 1v13" />
        <path d="M20 17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h14" />
        <path d="M9 8h6M9 12h6" />
      </>
    ),
    shield: (
      <>
        <path d="M12 3 5 6v5c0 4.4 3 8.2 7 10 4-1.8 7-5.6 7-10V6l-7-3Z" />
        <path d="m9.5 12 2 2 3.5-4" />
      </>
    ),
    send: <path d="M4 12 20 4l-4 16-4.5-6.5L4 12Zm7.5 1.5L20 4" />,
    check: <path d="m5 12.5 4.5 4.5L19 7" />,
    x: <path d="M6 6l12 12M18 6 6 18" />,
    pause: (
      <>
        <rect x="6" y="5" width="4" height="14" rx="1" />
        <rect x="14" y="5" width="4" height="14" rx="1" />
      </>
    ),
    play: <path d="M7 5v14l12-7L7 5Z" />,
    zap: <path d="M13 2 4.5 13.5H11L9.5 22 19 10h-6.5L13 2Z" />,
    clock: (
      <>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 7.5V12l3 2" />
      </>
    ),
    refresh: (
      <>
        <path d="M20 12a8 8 0 1 1-2.3-5.6" />
        <path d="M20 3v4h-4" />
      </>
    ),
    alert: (
      <>
        <path d="M12 4 2.8 19.5h18.4L12 4Z" />
        <path d="M12 10v4M12 16.8v.2" />
      </>
    ),
    arrow: <path d="M5 12h14m0 0-6-6m6 6-6 6" />,
    up: <path d="M12 19V5m0 0-6 6m6-6 6 6" />,
    down: <path d="M12 5v14m0 0-6-6m6 6 6-6" />,
    eye: (
      <>
        <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
        <circle cx="12" cy="12" r="2.8" />
      </>
    ),
    lock: (
      <>
        <rect x="5" y="11" width="14" height="9" rx="2" />
        <path d="M8 11V8a4 4 0 1 1 8 0v3" />
      </>
    ),
    chat: (
      <>
        <path d="M20 12a8 8 0 1 0-15 3.9L4 20l4.2-1A8 8 0 0 0 20 12Z" />
      </>
    ),
    wallet: (
      <>
        <path d="M3 7a2 2 0 0 1 2-2h13a1 1 0 0 1 1 1v2" />
        <path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2H5a2 2 0 0 1-2-2Z" />
        <circle cx="16.5" cy="14" r="1" fill="currentColor" stroke="none" />
      </>
    ),
    sparkle: (
      <path d="M12 3c.6 3.9 2.1 5.4 6 6-3.9.6-5.4 2.1-6 6-.6-3.9-2.1-5.4-6-6 3.9-.6 5.4-2.1 6-6ZM19 15c.3 1.8 1 2.5 2.8 2.8-1.8.3-2.5 1-2.8 2.8-.3-1.8-1-2.5-2.8-2.8 1.8-.3 2.5-1 2.8-2.8Z" />
    ),
    trash: (
      <>
        <path d="M4 7h16M9 7V4h6v3M6.5 7l1 13h9l1-13" />
      </>
    ),
    chevronDown: (
      <>
        <path d="m6 9 6 6 6-6" />
      </>
    ),
  };

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {paths[name] ?? <circle cx="12" cy="12" r="8" />}
    </svg>
  );
}
