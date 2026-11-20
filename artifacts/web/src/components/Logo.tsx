export function CatMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-label="Monitoring">
      <path d="M6 13 L7.5 4 L13 9.5 Z" fill="#ffb84d" />
      <path d="M26 13 L24.5 4 L19 9.5 Z" fill="#ffb84d" />
      <ellipse cx="16" cy="18" rx="11" ry="10" fill="#ffb84d" />
      <ellipse cx="11.6" cy="17" rx="1.7" ry="2.3" fill="#1d1438" />
      <ellipse cx="20.4" cy="17" rx="1.7" ry="2.3" fill="#1d1438" />
      <path d="M14.6 21.2 h2.8 l-1.4 1.6 z" fill="#e5484d" />
      <path d="M4 20 h5 M4 23 h5 M23 20 h5 M23 23 h5" stroke="#7c6cf0" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
