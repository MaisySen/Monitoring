export function MonitoringMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-label="Monitoring">
      <rect width="32" height="32" rx="7" fill="#3b2a73" />
      <path
        d="M6 18.5 H11 L13.5 10 L18 24 L20.5 15.5 L22.5 18.5 H26"
        fill="none"
        stroke="#ffb84d"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
