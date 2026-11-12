export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ANTHROPIC_API_KEY: string;
  AGENT_ID: string;
  ENVIRONMENT_ID: string;
  MUAPI_KEY?: string; // optional secret: a shared Muapi key for the Studio, so users need not bring their own
  VAULT_ID?: string; // vault holding the ANTHROPIC_API_KEY credential the sandbox uses for Deep Analysis (TradingAgents)
  LOGIN_PASSWORD?: string; // secret; when set, the app uses its own password login instead of Cloudflare Access
  ACCESS_TEAM_DOMAIN: string; // e.g. nesr.cloudflareaccess.com
  ACCESS_AUD: string; // Application Audience (AUD) tag from the Access application
  ANTHROPIC_BASE_URL?: string; // optional, e.g. a Cloudflare AI Gateway URL
  ANTHROPIC_WORKSPACE?: string; // workspace id for Console trace links; "default" if unset
  ALPACA_KEY_ID?: string; // secret: Alpaca market-data key (real-time quotes and bars)
  ALPACA_SECRET_KEY?: string; // secret
  ALPACA_DATA_BASE?: string; // tests only: mock Alpaca data server
  MARKET_DATA_BASE?: string; // tests only: mock market-data server
  DEV_NO_AUTH?: string; // "1" only in .dev.vars for local `wrangler dev`
  DEV_CLOCK_SHIFT_SEC?: string; // tests only (.dev.vars): pretend the clock is this many seconds ahead
}
