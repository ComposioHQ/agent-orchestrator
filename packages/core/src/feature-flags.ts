export function isPortfolioEnabled(): boolean {
  return process.env["AO_ENABLE_PORTFOLIO"] === "1";
}
