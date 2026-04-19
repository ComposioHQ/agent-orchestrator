export function isPortfolioEnabled(): boolean {
  const v = process.env["AO_ENABLE_PORTFOLIO"];
  if (v === "0" || v === "false") return false;
  return true;
}
