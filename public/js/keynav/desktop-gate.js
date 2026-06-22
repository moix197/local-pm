// Leaf: desktop detection gate — desktop iff viewport > 768px (mirrors the
// existing @media (max-width:768px) breakpoint in app.css).
// Accepts an optional matchMedia stub for unit tests.

export function isDesktop(matchMediaFn = window.matchMedia) {
  return matchMediaFn('(min-width: 769px)').matches;
}
